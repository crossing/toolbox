package retry

import (
	"context"
	"errors"
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

func New(config Config) (*Policy, error) {
	return newWithJitter(config, func(ceiling time.Duration) time.Duration {
		if ceiling <= 0 {
			return 0
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
	if hinted := RetryAfter(header, now); hinted > delay {
		delay = hinted
	}
	if delay > p.config.MaxDelay {
		delay = p.config.MaxDelay
	}
	return Decision{Retry: true, Delay: delay}
}

func retryable(status int, err error) bool {
	if err != nil {
		return !errors.Is(err, context.Canceled)
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
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(value); err == nil && at.After(now) {
		delay = at.Sub(now)
	}

	if milliseconds, err := strconv.ParseInt(strings.TrimSpace(header.Get("retry-after-ms")), 10, 64); err == nil && milliseconds >= 0 {
		candidate := time.Duration(milliseconds) * time.Millisecond
		if candidate > delay {
			delay = candidate
		}
	}
	return delay
}
