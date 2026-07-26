package retry

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func testPolicy(t *testing.T, retries int, jitter time.Duration) *Policy {
	t.Helper()
	policy, err := newWithJitter(Config{
		MaxRetries: retries,
		BaseDelay:  time.Second,
		MaxDelay:   5 * time.Minute,
	}, func(time.Duration) time.Duration { return jitter })
	if err != nil {
		t.Fatalf("newWithJitter() error = %v", err)
	}
	return policy
}

func TestRetryableStatusesAndTransportErrors(t *testing.T) {
	policy := testPolicy(t, 2, 250*time.Millisecond)
	for _, status := range []int{429, 500, 502, 503, 504} {
		decision := policy.Decide(0, status, nil, nil, time.Time{})
		if !decision.Retry || decision.Delay != 250*time.Millisecond {
			t.Fatalf("status %d decision = %#v", status, decision)
		}
	}
	if decision := policy.Decide(0, 0, nil, errors.New("dial failed"), time.Time{}); !decision.Retry {
		t.Fatalf("transport decision = %#v", decision)
	}
	for _, status := range []int{400, 401, 403, 404} {
		if decision := policy.Decide(0, status, nil, nil, time.Time{}); decision.Retry {
			t.Fatalf("status %d unexpectedly retried", status)
		}
	}
	if decision := policy.Decide(0, 0, nil, context.Canceled, time.Time{}); decision.Retry {
		t.Fatal("context cancellation unexpectedly retried")
	}
}

func TestRetryBoundAndExponentialCeiling(t *testing.T) {
	policy := testPolicy(t, 2, 10*time.Minute)
	if got := policy.Decide(0, 503, nil, nil, time.Time{}).Delay; got != time.Second {
		t.Fatalf("initial capped jitter = %s", got)
	}
	if got := policy.Decide(1, 503, nil, nil, time.Time{}).Delay; got != 2*time.Second {
		t.Fatalf("second capped jitter = %s", got)
	}
	if decision := policy.Decide(2, 503, nil, nil, time.Time{}); decision.Retry {
		t.Fatalf("retry bound decision = %#v", decision)
	}
}

func TestRetryAfterDeltaDateMillisecondsAndMaximum(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	policy := testPolicy(t, 3, 100*time.Millisecond)

	header := http.Header{"Retry-After": {"7"}, "Retry-After-Ms": {"9500"}}
	if got := policy.Decide(0, 429, header, nil, now).Delay; got != 9500*time.Millisecond {
		t.Fatalf("combined retry hint = %s", got)
	}

	header = http.Header{"Retry-After": {now.Add(12 * time.Second).Format(http.TimeFormat)}}
	if got := RetryAfter(header, now); got != 12*time.Second {
		t.Fatalf("date retry hint = %s", got)
	}

	header = http.Header{"Retry-After": {"9999"}}
	if got := policy.Decide(0, 429, header, nil, now).Delay; got != 5*time.Minute {
		t.Fatalf("maximum retry delay = %s", got)
	}
}

func TestInvalidRetryConfiguration(t *testing.T) {
	for _, config := range []Config{
		{MaxRetries: -1, BaseDelay: time.Second, MaxDelay: time.Minute},
		{MaxRetries: 1, BaseDelay: 0, MaxDelay: time.Minute},
		{MaxRetries: 1, BaseDelay: 2 * time.Minute, MaxDelay: time.Minute},
	} {
		if _, err := New(config); err == nil {
			t.Fatalf("New(%#v) unexpectedly succeeded", config)
		}
	}
}
