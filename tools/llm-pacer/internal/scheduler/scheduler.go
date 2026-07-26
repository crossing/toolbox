// Package scheduler coordinates bounded request admission and rate-paced
// outbound attempts for the proxy.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

const (
	// RateLimitSlowdownFactor multiplies the pacing interval after each 429.
	RateLimitSlowdownFactor = 1.25
	// SuccessRecoveryFactor reduces the accumulated pacing slowdown after a
	// complete success streak.
	SuccessRecoveryFactor = 0.95
	// SuccessesPerRecovery is the number of consecutive successful attempts
	// required for one recovery step.
	SuccessesPerRecovery = 20
	maxTimerDuration     = time.Duration(1<<63 - 1)
)

var (
	// ErrQueueFull matches every QueueFullError.
	ErrQueueFull = errors.New("scheduler admission capacity exhausted")
	// ErrInvalidConfig matches every ConfigError.
	ErrInvalidConfig = errors.New("invalid scheduler configuration")
	// ErrMisuse matches every MisuseError.
	ErrMisuse = errors.New("scheduler lifecycle misuse")
)

// QueueResource identifies the admission bound that rejected a request.
type QueueResource string

const (
	QueueResourceCount QueueResource = "request_count"
	QueueResourceBytes QueueResource = "retained_body_bytes"
)

// QueueFullError describes a rejected admission without exposing request data.
type QueueFullError struct {
	Resource  QueueResource
	Limit     int64
	Current   int64
	Requested int64
}

func (e *QueueFullError) Error() string {
	return fmt.Sprintf("%s capacity exhausted: current=%d requested=%d limit=%d", e.Resource, e.Current, e.Requested, e.Limit)
}

func (e *QueueFullError) Is(target error) bool {
	return target == ErrQueueFull
}

// ConfigError identifies one invalid configuration field.
type ConfigError struct {
	Field  string
	Reason string
}

func (e *ConfigError) Error() string {
	return fmt.Sprintf("invalid scheduler configuration %s: %s", e.Field, e.Reason)
}

func (e *ConfigError) Is(target error) bool {
	return target == ErrInvalidConfig
}

// MisuseKind identifies a caller lifecycle violation.
type MisuseKind string

const (
	MisuseNilContext       MisuseKind = "nil_context"
	MisuseInvalidBodyBytes MisuseKind = "invalid_body_bytes"
	MisuseSchedulerClosed  MisuseKind = "scheduler_closed"
	MisuseTicketClosed     MisuseKind = "ticket_closed"
	MisuseTicketBusy       MisuseKind = "ticket_busy"
	MisuseAttemptFinished  MisuseKind = "attempt_finished"
	MisuseInvalidOutcome   MisuseKind = "invalid_outcome"
)

// MisuseError is returned when the lifecycle API is called out of order or
// with an invalid value.
type MisuseError struct {
	Operation string
	Kind      MisuseKind
	Reason    string
}

func (e *MisuseError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("scheduler %s: %s", e.Operation, e.Kind)
	}
	return fmt.Sprintf("scheduler %s: %s: %s", e.Operation, e.Kind, e.Reason)
}

func (e *MisuseError) Is(target error) bool {
	if target == ErrMisuse {
		return true
	}
	other, ok := target.(*MisuseError)
	return ok && (other.Kind == "" || other.Kind == e.Kind)
}

// Clock is the time seam used by the scheduler. Implementations must be safe
// for concurrent use.
type Clock interface {
	Now() time.Time
	NewTimer(time.Duration) Timer
}

// Timer is the subset of time.Timer needed by the scheduler.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

func (systemClock) NewTimer(d time.Duration) Timer {
	return &systemTimer{Timer: time.NewTimer(d)}
}

type systemTimer struct {
	*time.Timer
}

func (t *systemTimer) C() <-chan time.Time { return t.Timer.C }

// Config contains the scheduler's hard limits and configured request rate.
// All numeric fields are required and must be positive. A nil Clock selects
// the system clock.
type Config struct {
	RequestsPerMinute    float64
	MinRequestsPerMinute float64
	MaxInflightAttempts  int
	MaxAdmittedRequests  int
	MaxRetainedBodyBytes int64
	Clock                Clock
}

// Outcome reports the result of one outbound attempt. StatusCode may be zero
// for a transport failure, otherwise it must be an HTTP status code. Positive
// RetryAfter and NotBefore values establish a global lower bound for the next
// attempt start.
type Outcome struct {
	StatusCode int
	RetryAfter time.Duration
	NotBefore  time.Time
}

// Snapshot is an atomic view of pacing and capacity state.
type Snapshot struct {
	ConfiguredRPM       float64
	EffectiveRPM        float64
	ActiveAttempts      int
	QueuedAttempts      int
	BackingOff          bool
	AdmittedRequests    int
	RetainedBodyBytes   int64
	RequestCountLimit   int
	RetainedBytesLimit  int64
	MaxInflightAttempts int
	NotBefore           time.Time
}

// Scheduler admits retained requests and dispatches their outbound attempts.
type Scheduler struct {
	mu sync.Mutex

	clock Clock
	cfg   Config

	queue         []*attemptWaiter
	active        int
	admitted      int
	retainedBytes int64

	intervalScale float64
	successStreak int
	lastStart     time.Time
	notBefore     time.Time

	wake      chan struct{}
	stop      chan struct{}
	closed    bool
	closeOnce sync.Once
	done      chan struct{}
}

type waiterState uint8

const (
	waiterQueued waiterState = iota
	waiterStarted
	waiterCanceled
)

type attemptWaiter struct {
	ctx    context.Context
	ticket *Ticket
	ready  chan attemptResult
	state  waiterState // guarded by Scheduler.mu
}

type attemptResult struct {
	attempt *Attempt
	err     error
}

// Ticket represents one admitted inbound request. A ticket retains admission
// across retries; only Close releases its request-count and byte capacity.
type Ticket struct {
	scheduler         *Scheduler
	retainedBodyBytes int64

	mu      sync.Mutex
	closed  bool
	pending bool
}

// Attempt represents one started outbound attempt. Finish must be called once
// after the upstream exchange ends, including on transport failure.
type Attempt struct {
	scheduler *Scheduler
	ticket    *Ticket

	mu       sync.Mutex
	finished bool
}

// New validates config and starts a scheduler.
func New(cfg Config) (*Scheduler, error) {
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}
	clock := cfg.Clock
	if clock == nil {
		clock = systemClock{}
	}
	s := &Scheduler{
		clock:         clock,
		cfg:           cfg,
		intervalScale: 1,
		wake:          make(chan struct{}, 1),
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	go s.run()
	return s, nil
}

func validateConfig(cfg Config) error {
	if math.IsNaN(cfg.RequestsPerMinute) || math.IsInf(cfg.RequestsPerMinute, 0) || cfg.RequestsPerMinute <= 0 {
		return &ConfigError{Field: "RequestsPerMinute", Reason: "must be finite and positive"}
	}
	intervalNanos := float64(time.Minute) / cfg.RequestsPerMinute
	if intervalNanos < 1 {
		return &ConfigError{Field: "RequestsPerMinute", Reason: "is too large for nanosecond pacing"}
	}
	if intervalNanos > float64(maxTimerDuration) {
		return &ConfigError{Field: "RequestsPerMinute", Reason: "is too small for time.Duration pacing"}
	}
	if math.IsNaN(cfg.MinRequestsPerMinute) || math.IsInf(cfg.MinRequestsPerMinute, 0) || cfg.MinRequestsPerMinute <= 0 {
		return &ConfigError{Field: "MinRequestsPerMinute", Reason: "must be finite and positive"}
	}
	if cfg.MinRequestsPerMinute > cfg.RequestsPerMinute {
		return &ConfigError{Field: "MinRequestsPerMinute", Reason: "must not exceed RequestsPerMinute"}
	}
	if cfg.MaxInflightAttempts <= 0 {
		return &ConfigError{Field: "MaxInflightAttempts", Reason: "must be positive"}
	}
	if cfg.MaxAdmittedRequests <= 0 {
		return &ConfigError{Field: "MaxAdmittedRequests", Reason: "must be positive"}
	}
	if cfg.MaxRetainedBodyBytes <= 0 {
		return &ConfigError{Field: "MaxRetainedBodyBytes", Reason: "must be positive"}
	}
	return nil
}

// Admit reserves one request slot and retained-body capacity. It never waits
// for capacity; callers can map QueueFullError to a local HTTP 429.
func (s *Scheduler) Admit(ctx context.Context, retainedBodyBytes int64) (*Ticket, error) {
	if ctx == nil {
		return nil, &MisuseError{Operation: "admit", Kind: MisuseNilContext}
	}
	if retainedBodyBytes < 0 {
		return nil, &MisuseError{Operation: "admit", Kind: MisuseInvalidBodyBytes, Reason: "must not be negative"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, &MisuseError{Operation: "admit", Kind: MisuseSchedulerClosed}
	}
	if s.admitted >= s.cfg.MaxAdmittedRequests {
		return nil, &QueueFullError{
			Resource:  QueueResourceCount,
			Limit:     int64(s.cfg.MaxAdmittedRequests),
			Current:   int64(s.admitted),
			Requested: 1,
		}
	}
	if retainedBodyBytes > s.cfg.MaxRetainedBodyBytes-s.retainedBytes {
		return nil, &QueueFullError{
			Resource:  QueueResourceBytes,
			Limit:     s.cfg.MaxRetainedBodyBytes,
			Current:   s.retainedBytes,
			Requested: retainedBodyBytes,
		}
	}
	s.admitted++
	s.retainedBytes += retainedBodyBytes
	return &Ticket{scheduler: s, retainedBodyBytes: retainedBodyBytes}, nil
}

// RequestAttempt appends an outbound attempt to the global FIFO and waits for
// its pacing and inflight gates. After Finish, the same ticket may request a
// retry, which naturally re-enters at the tail.
func (t *Ticket) RequestAttempt(ctx context.Context) (*Attempt, error) {
	if ctx == nil {
		return nil, &MisuseError{Operation: "request attempt", Kind: MisuseNilContext}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := t.beginAttemptRequest(); err != nil {
		return nil, err
	}

	w := &attemptWaiter{
		ctx:    ctx,
		ticket: t,
		ready:  make(chan attemptResult, 1),
		state:  waiterQueued,
	}
	if err := t.scheduler.enqueue(w); err != nil {
		t.endAttemptRequest()
		return nil, err
	}

	select {
	case result := <-w.ready:
		return result.attempt, result.err
	case <-ctx.Done():
		if t.scheduler.cancelWaiting(w, ctx.Err()) {
			return nil, ctx.Err()
		}
		// Dispatch won the race with cancellation. Consume the started attempt
		// and release its inflight slot because ownership was never returned to
		// the caller.
		result := <-w.ready
		if result.attempt != nil {
			_ = result.attempt.Finish(Outcome{})
		}
		if result.err != nil {
			return nil, result.err
		}
		return nil, ctx.Err()
	}
}

func (t *Ticket) beginAttemptRequest() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return &MisuseError{Operation: "request attempt", Kind: MisuseTicketClosed}
	}
	if t.pending {
		return &MisuseError{Operation: "request attempt", Kind: MisuseTicketBusy}
	}
	t.pending = true
	return nil
}

func (t *Ticket) endAttemptRequest() {
	t.mu.Lock()
	t.pending = false
	t.mu.Unlock()
}

// Close releases this request's admission capacity. Closing a ticket with a
// waiting or active attempt is rejected so admission covers the full attempt
// lifetime. Repeated Close calls never double-release capacity.
func (t *Ticket) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return &MisuseError{Operation: "close ticket", Kind: MisuseTicketClosed}
	}
	if t.pending {
		t.mu.Unlock()
		return &MisuseError{Operation: "close ticket", Kind: MisuseTicketBusy}
	}
	t.closed = true
	t.mu.Unlock()

	t.scheduler.releaseAdmission(t.retainedBodyBytes)
	return nil
}

// Finish reports the outcome and releases one inflight slot. Invalid outcomes
// are rejected before the attempt is consumed, allowing the caller to correct
// and retry Finish. Concurrent or repeated successful Finish calls release
// capacity exactly once.
func (a *Attempt) Finish(outcome Outcome) error {
	if err := validateOutcome(outcome); err != nil {
		return err
	}
	a.mu.Lock()
	if a.finished {
		a.mu.Unlock()
		return &MisuseError{Operation: "finish attempt", Kind: MisuseAttemptFinished}
	}
	a.finished = true
	a.mu.Unlock()

	a.scheduler.finishAttempt(a.ticket, outcome)
	return nil
}

func validateOutcome(outcome Outcome) error {
	if outcome.StatusCode != 0 && (outcome.StatusCode < 100 || outcome.StatusCode > 599) {
		return &MisuseError{Operation: "finish attempt", Kind: MisuseInvalidOutcome, Reason: "status code must be zero or 100..599"}
	}
	if outcome.RetryAfter < 0 {
		return &MisuseError{Operation: "finish attempt", Kind: MisuseInvalidOutcome, Reason: "retry-after must not be negative"}
	}
	return nil
}

func (s *Scheduler) enqueue(w *attemptWaiter) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return &MisuseError{Operation: "request attempt", Kind: MisuseSchedulerClosed}
	}
	s.queue = append(s.queue, w)
	s.mu.Unlock()
	s.notify()
	return nil
}

func (s *Scheduler) cancelWaiting(w *attemptWaiter, cause error) bool {
	s.mu.Lock()
	if w.state != waiterQueued {
		s.mu.Unlock()
		return false
	}
	for i, candidate := range s.queue {
		if candidate != w {
			continue
		}
		s.queue = append(s.queue[:i], s.queue[i+1:]...)
		w.state = waiterCanceled
		w.ticket.endAttemptRequest()
		s.mu.Unlock()
		w.ready <- attemptResult{err: cause}
		s.notify()
		return true
	}
	s.mu.Unlock()
	return false
}

func (s *Scheduler) releaseAdmission(retainedBodyBytes int64) {
	s.mu.Lock()
	s.admitted--
	s.retainedBytes -= retainedBodyBytes
	s.mu.Unlock()
}

func (s *Scheduler) finishAttempt(ticket *Ticket, outcome Outcome) {
	s.mu.Lock()
	s.active--
	ticket.endAttemptRequest()

	now := s.clock.Now()
	hint := outcome.NotBefore
	if outcome.RetryAfter > 0 {
		relative := now.Add(outcome.RetryAfter)
		if hint.Before(relative) {
			hint = relative
		}
	}
	if s.notBefore.Before(hint) {
		s.notBefore = hint
	}

	switch {
	case outcome.StatusCode == 429:
		s.intervalScale *= RateLimitSlowdownFactor
		maxScale := s.cfg.RequestsPerMinute / s.cfg.MinRequestsPerMinute
		if math.IsInf(s.intervalScale, 0) || s.intervalScale > maxScale {
			s.intervalScale = maxScale
		}
		s.successStreak = 0
	case outcome.StatusCode >= 200 && outcome.StatusCode <= 299:
		if s.intervalScale > 1 {
			s.successStreak++
			if s.successStreak >= SuccessesPerRecovery {
				s.intervalScale *= SuccessRecoveryFactor
				if s.intervalScale < 1 {
					s.intervalScale = 1
				}
				s.successStreak = 0
			}
		} else {
			s.successStreak = 0
		}
	default:
		s.successStreak = 0
	}
	s.mu.Unlock()
	s.notify()
}

// Snapshot returns a race-safe point-in-time view.
func (s *Scheduler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	return Snapshot{
		ConfiguredRPM:       s.cfg.RequestsPerMinute,
		EffectiveRPM:        s.effectiveRPMLocked(),
		ActiveAttempts:      s.active,
		QueuedAttempts:      len(s.queue),
		BackingOff:          s.intervalScale > 1 || now.Before(s.notBefore),
		AdmittedRequests:    s.admitted,
		RetainedBodyBytes:   s.retainedBytes,
		RequestCountLimit:   s.cfg.MaxAdmittedRequests,
		RetainedBytesLimit:  s.cfg.MaxRetainedBodyBytes,
		MaxInflightAttempts: s.cfg.MaxInflightAttempts,
		NotBefore:           s.notBefore,
	}
}

func (s *Scheduler) effectiveRPMLocked() float64 {
	return s.cfg.RequestsPerMinute / s.intervalScale
}

// Close stops future dispatch and rejects queued attempts. Active attempts can
// still call Finish, and all admitted tickets can still call Close.
func (s *Scheduler) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		queued := s.queue
		s.queue = nil
		for _, w := range queued {
			w.state = waiterCanceled
			w.ticket.endAttemptRequest()
			w.ready <- attemptResult{err: &MisuseError{Operation: "request attempt", Kind: MisuseSchedulerClosed}}
		}
		s.mu.Unlock()
		close(s.stop)
	})
	<-s.done
	return nil
}

func (s *Scheduler) run() {
	defer close(s.done)
	for {
		wait, hasTimer := s.dispatchReady()
		if !hasTimer {
			select {
			case <-s.wake:
				continue
			case <-s.stop:
				return
			}
		}

		timer := s.clock.NewTimer(wait)
		select {
		case <-timer.C():
		case <-s.wake:
			stopAndDrain(timer)
		case <-s.stop:
			stopAndDrain(timer)
			return
		}
	}
}

// dispatchReady starts at most one attempt. Updating lastStart before looping
// prevents catch-up bursts even when the clock advances by several intervals.
func (s *Scheduler) dispatchReady() (time.Duration, bool) {
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return 0, false
		}

		for len(s.queue) > 0 {
			w := s.queue[0]
			if w.ctx.Err() == nil {
				break
			}
			s.queue = s.queue[1:]
			w.state = waiterCanceled
			w.ticket.endAttemptRequest()
			w.ready <- attemptResult{err: w.ctx.Err()}
		}

		if len(s.queue) == 0 || s.active >= s.cfg.MaxInflightAttempts {
			s.mu.Unlock()
			return 0, false
		}

		now := s.clock.Now()
		earliest := s.notBefore
		if !s.lastStart.IsZero() {
			paced := s.lastStart.Add(intervalForRPM(s.effectiveRPMLocked()))
			if earliest.Before(paced) {
				earliest = paced
			}
		}
		if now.Before(earliest) {
			s.mu.Unlock()
			return earliest.Sub(now), true
		}

		w := s.queue[0]
		s.queue = s.queue[1:]
		w.state = waiterStarted
		s.active++
		s.lastStart = now
		attempt := &Attempt{scheduler: s, ticket: w.ticket}
		s.mu.Unlock()
		w.ready <- attemptResult{attempt: attempt}
		return 0, true
	}
}

func intervalForRPM(rpm float64) time.Duration {
	intervalNanos := float64(time.Minute) / rpm
	if math.IsInf(intervalNanos, 0) || intervalNanos >= float64(maxTimerDuration) {
		return maxTimerDuration
	}
	return time.Duration(intervalNanos)
}

func (s *Scheduler) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func stopAndDrain(timer Timer) {
	if timer.Stop() {
		return
	}
	select {
	case <-timer.C():
	default:
	}
}
