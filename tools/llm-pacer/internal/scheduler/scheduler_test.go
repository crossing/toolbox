package scheduler

import (
	"context"
	"errors"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var testEpoch = time.Date(2026, time.July, 26, 12, 0, 0, 0, time.UTC)

type manualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*manualTimer
}

type manualTimer struct {
	clock    *manualClock
	deadline time.Time
	ch       chan time.Time
	stopped  bool
	fired    bool
}

func newManualClock() *manualClock {
	return &manualClock{now: testEpoch}
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &manualTimer{
		clock:    c,
		deadline: c.now.Add(d),
		ch:       make(chan time.Time, 1),
	}
	c.timers = append(c.timers, timer)
	if d <= 0 {
		timer.fired = true
		timer.ch <- c.now
	}
	return timer
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	for _, timer := range c.timers {
		if timer.stopped || timer.fired || timer.deadline.After(now) {
			continue
		}
		timer.fired = true
		timer.ch <- now
	}
	c.mu.Unlock()
}

func (c *manualClock) pendingTimers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, timer := range c.timers {
		if !timer.stopped && !timer.fired {
			count++
		}
	}
	return count
}

func (t *manualTimer) C() <-chan time.Time { return t.ch }

func (t *manualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

func testConfig(clock Clock) Config {
	return Config{
		RequestsPerMinute:    60,
		MinRequestsPerMinute: 1,
		MaxInflightAttempts:  3,
		MaxAdmittedRequests:  10,
		MaxRetainedBodyBytes: 1 << 20,
		Clock:                clock,
	}
}

type attemptCall struct {
	attempt *Attempt
	err     error
}

func requestAsync(ticket *Ticket, ctx context.Context) <-chan attemptCall {
	result := make(chan attemptCall, 1)
	go func() {
		attempt, err := ticket.RequestAttempt(ctx)
		result <- attemptCall{attempt: attempt, err: err}
	}()
	return result
}

func receiveAttempt(t *testing.T, result <-chan attemptCall) *Attempt {
	t.Helper()
	select {
	case call := <-result:
		if call.err != nil {
			t.Fatalf("RequestAttempt() error = %v", call.err)
		}
		if call.attempt == nil {
			t.Fatal("RequestAttempt() returned a nil attempt")
		}
		return call.attempt
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for attempt")
		return nil
	}
}

func assertNotStarted(t *testing.T, result <-chan attemptCall) {
	t.Helper()
	select {
	case call := <-result:
		t.Fatalf("attempt started early: %+v", call)
	default:
	}
}

func waitFor(t *testing.T, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		runtime.Gosched()
		time.Sleep(time.Millisecond)
	}
}

func waitForTimer(t *testing.T, clock *manualClock) {
	t.Helper()
	waitFor(t, func() bool { return clock.pendingTimers() > 0 }, "scheduler timer")
}

func admit(t *testing.T, scheduler *Scheduler, bytes int64) *Ticket {
	t.Helper()
	ticket, err := scheduler.Admit(context.Background(), bytes)
	if err != nil {
		t.Fatalf("Admit() error = %v", err)
	}
	return ticket
}

func TestAttemptFIFO(t *testing.T) {
	clock := newManualClock()
	scheduler, err := New(testConfig(clock))
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	firstTicket := admit(t, scheduler, 1)
	secondTicket := admit(t, scheduler, 1)
	thirdTicket := admit(t, scheduler, 1)
	firstResult := requestAsync(firstTicket, context.Background())
	first := receiveAttempt(t, firstResult)
	secondResult := requestAsync(secondTicket, context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 1 }, "second queued attempt")
	thirdResult := requestAsync(thirdTicket, context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 2 }, "two queued attempts")

	waitForTimer(t, clock)
	clock.Advance(time.Second)
	second := receiveAttempt(t, secondResult)
	assertNotStarted(t, thirdResult)

	waitForTimer(t, clock)
	clock.Advance(time.Second)
	third := receiveAttempt(t, thirdResult)

	for _, attempt := range []*Attempt{first, second, third} {
		if err := attempt.Finish(Outcome{StatusCode: 200}); err != nil {
			t.Fatal(err)
		}
	}
	for _, ticket := range []*Ticket{firstTicket, secondTicket, thirdTicket} {
		if err := ticket.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAttemptSpacingHasNoInitialOrCatchUpBurst(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.MaxInflightAttempts = 10
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	tickets := []*Ticket{admit(t, scheduler, 0), admit(t, scheduler, 0), admit(t, scheduler, 0)}
	results := make([]<-chan attemptCall, 3)
	results[0] = requestAsync(tickets[0], context.Background())
	first := receiveAttempt(t, results[0])
	results[1] = requestAsync(tickets[1], context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 1 }, "first paced attempt")
	results[2] = requestAsync(tickets[2], context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 2 }, "paced queue")
	assertNotStarted(t, results[1])
	assertNotStarted(t, results[2])

	waitForTimer(t, clock)
	clock.Advance(999 * time.Millisecond)
	assertNotStarted(t, results[1])
	clock.Advance(time.Millisecond)
	second := receiveAttempt(t, results[1])
	assertNotStarted(t, results[2])

	// Advancing far beyond the next interval permits only one start at the new
	// clock value; the scheduler never catches up by bursting queued work.
	waitForTimer(t, clock)
	clock.Advance(10 * time.Second)
	third := receiveAttempt(t, results[2])

	for _, attempt := range []*Attempt{first, second, third} {
		if err := attempt.Finish(Outcome{StatusCode: 200}); err != nil {
			t.Fatal(err)
		}
	}
	for _, ticket := range tickets {
		if err := ticket.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMaxInflightAttempts(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.MaxInflightAttempts = 2
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	tickets := []*Ticket{admit(t, scheduler, 0), admit(t, scheduler, 0), admit(t, scheduler, 0)}
	results := make([]<-chan attemptCall, 3)
	results[0] = requestAsync(tickets[0], context.Background())
	first := receiveAttempt(t, results[0])
	results[1] = requestAsync(tickets[1], context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 1 }, "second attempt queue")
	waitForTimer(t, clock)
	clock.Advance(time.Second)
	second := receiveAttempt(t, results[1])
	results[2] = requestAsync(tickets[2], context.Background())
	waitFor(t, func() bool {
		snapshot := scheduler.Snapshot()
		return snapshot.ActiveAttempts == 2 && snapshot.QueuedAttempts == 1
	}, "inflight saturation")

	clock.Advance(10 * time.Second)
	assertNotStarted(t, results[2])
	if err := first.Finish(Outcome{StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	third := receiveAttempt(t, results[2])

	if err := second.Finish(Outcome{StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	if err := third.Finish(Outcome{StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	for _, ticket := range tickets {
		if err := ticket.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAdmissionCountAndByteBounds(t *testing.T) {
	cfg := testConfig(nil)
	cfg.MaxAdmittedRequests = 2
	cfg.MaxRetainedBodyBytes = 10
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	first := admit(t, scheduler, 7)
	second := admit(t, scheduler, 0)
	_, err = scheduler.Admit(context.Background(), 0)
	var countFull *QueueFullError
	if !errors.Is(err, ErrQueueFull) || !errors.As(err, &countFull) || countFull.Resource != QueueResourceCount {
		t.Fatalf("count overflow error = %#v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = scheduler.Admit(context.Background(), 4)
	var bytesFull *QueueFullError
	if !errors.Is(err, ErrQueueFull) || !errors.As(err, &bytesFull) || bytesFull.Resource != QueueResourceBytes {
		t.Fatalf("byte overflow error = %#v", err)
	}
	if got := scheduler.Snapshot(); got.AdmittedRequests != 1 || got.RetainedBodyBytes != 7 || got.RequestCountLimit != 2 || got.RetainedBytesLimit != 10 {
		t.Fatalf("snapshot after overflow = %+v", got)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	replacement := admit(t, scheduler, 10)
	if err := replacement.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCancellationAndExactlyOnceRelease(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.MaxInflightAttempts = 1
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	activeTicket := admit(t, scheduler, 3)
	canceledTicket := admit(t, scheduler, 5)
	active := receiveAttempt(t, requestAsync(activeTicket, context.Background()))
	ctx, cancel := context.WithCancel(context.Background())
	canceledResult := requestAsync(canceledTicket, ctx)
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 1 }, "cancelable queued attempt")
	cancel()
	select {
	case call := <-canceledResult:
		if !errors.Is(call.err, context.Canceled) || call.attempt != nil {
			t.Fatalf("canceled attempt result = %+v", call)
		}
	case <-time.After(time.Second):
		t.Fatal("queued cancellation did not return")
	}
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 0 }, "canceled attempt removal")
	if err := canceledTicket.Close(); err != nil {
		t.Fatalf("Close() after cancellation = %v", err)
	}

	finishResults := make(chan error, 2)
	go func() { finishResults <- active.Finish(Outcome{StatusCode: 200}) }()
	go func() { finishResults <- active.Finish(Outcome{StatusCode: 200}) }()
	var successful, rejected int
	for range 2 {
		finishErr := <-finishResults
		if finishErr == nil {
			successful++
		} else {
			var misuse *MisuseError
			if !errors.Is(finishErr, ErrMisuse) || !errors.As(finishErr, &misuse) || misuse.Kind != MisuseAttemptFinished {
				t.Fatalf("second Finish() error = %v", finishErr)
			}
			rejected++
		}
	}
	if successful != 1 || rejected != 1 {
		t.Fatalf("Finish() counts = success %d rejected %d", successful, rejected)
	}
	if err := activeTicket.Close(); err != nil {
		t.Fatal(err)
	}
	if err := activeTicket.Close(); err == nil {
		t.Fatal("second Close() unexpectedly succeeded")
	}
	if got := scheduler.Snapshot(); got.ActiveAttempts != 0 || got.AdmittedRequests != 0 || got.RetainedBodyBytes != 0 {
		t.Fatalf("capacity leaked or double-released: %+v", got)
	}
}

func TestRetryReentersQueueTail(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.MaxInflightAttempts = 1
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	retryingTicket := admit(t, scheduler, 1)
	otherTicket := admit(t, scheduler, 1)
	first := receiveAttempt(t, requestAsync(retryingTicket, context.Background()))
	otherResult := requestAsync(otherTicket, context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 1 }, "other request in queue")
	if err := first.Finish(Outcome{StatusCode: 500}); err != nil {
		t.Fatal(err)
	}
	retryResult := requestAsync(retryingTicket, context.Background())
	waitFor(t, func() bool { return scheduler.Snapshot().QueuedAttempts == 2 }, "retry at queue tail")

	waitForTimer(t, clock)
	clock.Advance(time.Second)
	other := receiveAttempt(t, otherResult)
	assertNotStarted(t, retryResult)
	if err := other.Finish(Outcome{StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	waitForTimer(t, clock)
	clock.Advance(time.Second)
	retry := receiveAttempt(t, retryResult)
	if err := retry.Finish(Outcome{StatusCode: 200}); err != nil {
		t.Fatal(err)
	}
	if err := retryingTicket.Close(); err != nil {
		t.Fatal(err)
	}
	if err := otherTicket.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAdaptiveSlowdownAndSuccessRecovery(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.RequestsPerMinute = 100
	cfg.MaxInflightAttempts = 1
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	ticket := admit(t, scheduler, 0)
	attempt := receiveAttempt(t, requestAsync(ticket, context.Background()))
	if err := attempt.Finish(Outcome{StatusCode: 429}); err != nil {
		t.Fatal(err)
	}
	slowed := scheduler.Snapshot()
	if math.Abs(slowed.EffectiveRPM-80) > 1e-9 || !slowed.BackingOff {
		t.Fatalf("snapshot after 429 = %+v", slowed)
	}

	for i := 0; i < SuccessesPerRecovery; i++ {
		result := requestAsync(ticket, context.Background())
		waitForTimer(t, clock)
		clock.Advance(intervalForRPM(scheduler.Snapshot().EffectiveRPM))
		attempt = receiveAttempt(t, result)
		if err := attempt.Finish(Outcome{StatusCode: 200}); err != nil {
			t.Fatal(err)
		}
	}
	recovered := scheduler.Snapshot()
	want := cfg.RequestsPerMinute / (RateLimitSlowdownFactor * SuccessRecoveryFactor)
	if math.Abs(recovered.EffectiveRPM-want) > 1e-9 {
		t.Fatalf("effective RPM after recovery = %v, want %v", recovered.EffectiveRPM, want)
	}
	if recovered.EffectiveRPM > cfg.RequestsPerMinute {
		t.Fatalf("effective RPM %v exceeds configured %v", recovered.EffectiveRPM, cfg.RequestsPerMinute)
	}
	if err := ticket.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAdaptiveSlowdownStopsAtMinimumRPM(t *testing.T) {
	clock := newManualClock()
	cfg := testConfig(clock)
	cfg.RequestsPerMinute = 10
	cfg.MinRequestsPerMinute = 8
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	ticket := admit(t, scheduler, 0)
	for i := 0; i < 5; i++ {
		result := requestAsync(ticket, context.Background())
		if i > 0 {
			waitForTimer(t, clock)
			clock.Advance(intervalForRPM(scheduler.Snapshot().EffectiveRPM))
		}
		attempt := receiveAttempt(t, result)
		if err := attempt.Finish(Outcome{StatusCode: 429}); err != nil {
			t.Fatal(err)
		}
	}
	if got := scheduler.Snapshot().EffectiveRPM; math.Abs(got-8) > 1e-9 {
		t.Fatalf("effective RPM = %v, want minimum 8", got)
	}
	if err := ticket.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRetryAfterAndNotBeforeAreGlobal(t *testing.T) {
	for _, tc := range []struct {
		name      string
		outcome   func(now time.Time) Outcome
		wantDelay time.Duration
	}{
		{
			name: "retry after",
			outcome: func(time.Time) Outcome {
				return Outcome{StatusCode: 429, RetryAfter: 5 * time.Second}
			},
			wantDelay: 5 * time.Second,
		},
		{
			name: "absolute not before wins",
			outcome: func(now time.Time) Outcome {
				return Outcome{StatusCode: 429, RetryAfter: 5 * time.Second, NotBefore: now.Add(7 * time.Second)}
			},
			wantDelay: 7 * time.Second,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock := newManualClock()
			scheduler, err := New(testConfig(clock))
			if err != nil {
				t.Fatal(err)
			}
			defer scheduler.Close()

			firstTicket := admit(t, scheduler, 0)
			secondTicket := admit(t, scheduler, 0)
			first := receiveAttempt(t, requestAsync(firstTicket, context.Background()))
			if err := first.Finish(tc.outcome(clock.Now())); err != nil {
				t.Fatal(err)
			}
			result := requestAsync(secondTicket, context.Background())
			waitForTimer(t, clock)
			clock.Advance(tc.wantDelay - time.Nanosecond)
			assertNotStarted(t, result)
			clock.Advance(time.Nanosecond)
			second := receiveAttempt(t, result)
			if err := second.Finish(Outcome{StatusCode: 200}); err != nil {
				t.Fatal(err)
			}
			if err := firstTicket.Close(); err != nil {
				t.Fatal(err)
			}
			if err := secondTicket.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestValidationAndLifecycleMisuseAreTyped(t *testing.T) {
	_, err := New(Config{})
	var configErr *ConfigError
	if !errors.Is(err, ErrInvalidConfig) || !errors.As(err, &configErr) {
		t.Fatalf("New() error = %#v", err)
	}

	scheduler, err := New(testConfig(nil))
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()
	_, err = scheduler.Admit(context.Background(), -1)
	var misuse *MisuseError
	if !errors.Is(err, ErrMisuse) || !errors.As(err, &misuse) || misuse.Kind != MisuseInvalidBodyBytes {
		t.Fatalf("negative body error = %#v", err)
	}

	ticket := admit(t, scheduler, 0)
	attempt := receiveAttempt(t, requestAsync(ticket, context.Background()))
	if err := ticket.Close(); err == nil {
		t.Fatal("Close() with active attempt unexpectedly succeeded")
	}
	if err := attempt.Finish(Outcome{StatusCode: 99}); err == nil {
		t.Fatal("Finish() accepted invalid status")
	}
	if err := attempt.Finish(Outcome{StatusCode: 204}); err != nil {
		t.Fatal(err)
	}
	if err := ticket.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentLifecycleIsRaceSafe(t *testing.T) {
	cfg := testConfig(nil)
	cfg.RequestsPerMinute = float64(time.Minute)
	cfg.MaxInflightAttempts = 8
	cfg.MaxAdmittedRequests = 64
	scheduler, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer scheduler.Close()

	var failures atomic.Int64
	var wg sync.WaitGroup
	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticket, admitErr := scheduler.Admit(context.Background(), 1)
			if admitErr != nil {
				failures.Add(1)
				return
			}
			attempt, attemptErr := ticket.RequestAttempt(context.Background())
			if attemptErr != nil {
				failures.Add(1)
				_ = ticket.Close()
				return
			}
			if attempt.Finish(Outcome{StatusCode: 200}) != nil {
				failures.Add(1)
			}
			if ticket.Close() != nil {
				failures.Add(1)
			}
		}()
	}
	wg.Wait()
	if failures.Load() != 0 {
		t.Fatalf("concurrent lifecycle failures = %d", failures.Load())
	}
	if got := scheduler.Snapshot(); got.ActiveAttempts != 0 || got.QueuedAttempts != 0 || got.AdmittedRequests != 0 || got.RetainedBodyBytes != 0 {
		t.Fatalf("concurrent lifecycle leaked capacity: %+v", got)
	}
}
