package retry

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	MaxRetries int
	BaseDelay  time.Duration
	MaxDelay   time.Duration
}

type Policy struct {
	config Config
	jitter func(time.Duration) time.Duration
}

type Decision struct {
	Retry bool
	Delay time.Duration
}

type safeTransportError struct {
	err error
}

func (err *safeTransportError) Error() string {
	return err.err.Error()
}

func (err *safeTransportError) Unwrap() error {
	return err.err
}

func (*safeTransportError) safeToRetryTransport() {}

// MarkSafeTransportError marks err as a transport failure that is known to
// have happened before the request could be sent. The wrapper preserves the
// original error for errors.Is and errors.As. A nil error remains nil.
func MarkSafeTransportError(err error) error {
	if err == nil || IsSafeTransportError(err) {
		return err
	}
	return &safeTransportError{err: err}
}

// IsSafeTransportError reports whether err contains the private marker added
// by MarkSafeTransportError.
func IsSafeTransportError(err error) bool {
	var marked interface{ safeToRetryTransport() }
	return errors.As(err, &marked)
}

func New(config Config) (*Policy, error) {
	return newWithJitter(config, func(ceiling time.Duration) time.Duration {
		if ceiling <= 0 {
			return 0
		}
		if ceiling == time.Duration(math.MaxInt64) {
			// Adding one for an inclusive bound would overflow Int64N's
			// argument. Excluding the single maximum value is immaterial to
			// jitter while preserving the configured upper bound.
			return time.Duration(rand.Int64N(math.MaxInt64))
		}
		return time.Duration(rand.Int64N(int64(ceiling) + 1))
	})
}

func newWithJitter(config Config, jitter func(time.Duration) time.Duration) (*Policy, error) {
	if config.MaxRetries < 0 || config.BaseDelay <= 0 || config.MaxDelay <= 0 || config.BaseDelay > config.MaxDelay {
		return nil, errors.New("invalid retry configuration")
	}
	if jitter == nil {
		return nil, errors.New("retry jitter source is required")
	}
	return &Policy{config: config, jitter: jitter}, nil
}

// Decide evaluates a completed attempt. retriesUsed is the number of retries
// already made, so zero describes the initial attempt.
func (p *Policy) Decide(retriesUsed, status int, header http.Header, err error, now time.Time) Decision {
	if retriesUsed >= p.config.MaxRetries || !retryable(status, err) {
		return Decision{}
	}

	ceiling := exponentialDelay(p.config.BaseDelay, p.config.MaxDelay, retriesUsed)
	delay := p.jitter(ceiling)
	if delay < 0 {
		delay = 0
	}
	if delay > ceiling {
		delay = ceiling
	}
	if hinted := p.RetryAfter(header, now); hinted > delay {
		delay = hinted
	}
	return Decision{Retry: true, Delay: delay}
}

func retryable(status int, err error) bool {
	if err != nil {
		return !errors.Is(err, context.Canceled) &&
			!errors.Is(err, context.DeadlineExceeded) &&
			IsSafeTransportError(err)
	}
	switch status {
	case http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

// RetryAfter returns the longer valid server retry hint, capped by the
// policy's configured MaxDelay.
func (p *Policy) RetryAfter(header http.Header, now time.Time) time.Duration {
	delay := RetryAfter(header, now)
	if delay > p.config.MaxDelay {
		return p.config.MaxDelay
	}
	return delay
}

func exponentialDelay(base, maximum time.Duration, exponent int) time.Duration {
	delay := base
	for range exponent {
		if delay >= maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

// RetryAfter returns the longer valid delay from Retry-After and the common
// retry-after-ms extension. Invalid or past hints are ignored.
func RetryAfter(header http.Header, now time.Time) time.Duration {
	if header == nil {
		return 0
	}
	var delay time.Duration
	value := strings.TrimSpace(header.Get("Retry-After"))
	if seconds, err := strconv.ParseUint(value, 10, 64); err == nil {
		delay = durationFromUint(seconds, time.Second)
	} else if at, err := http.ParseTime(value); err == nil && at.After(now) {
		delay = at.Sub(now)
	}

	if milliseconds, err := strconv.ParseUint(strings.TrimSpace(header.Get("retry-after-ms")), 10, 64); err == nil {
		candidate := durationFromUint(milliseconds, time.Millisecond)
		if candidate > delay {
			delay = candidate
		}
	}
	return delay
}

func durationFromUint(value uint64, unit time.Duration) time.Duration {
	if value > uint64(math.MaxInt64)/uint64(unit) {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(value) * unit
}
