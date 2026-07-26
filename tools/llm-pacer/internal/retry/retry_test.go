package retry

import (
	"context"
	"errors"
	"math"
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
	transportErr := errors.New("dial failed")
	if decision := policy.Decide(0, 0, nil, MarkSafeTransportError(transportErr), time.Time{}); !decision.Retry {
		t.Fatalf("transport decision = %#v", decision)
	}
	if decision := policy.Decide(0, 0, nil, transportErr, time.Time{}); decision.Retry {
		t.Fatalf("unmarked transport decision = %#v", decision)
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

func TestSafeTransportErrorMarkerPreservesErrorChain(t *testing.T) {
	sentinel := errors.New("sentinel")
	marked := MarkSafeTransportError(sentinel)
	if !IsSafeTransportError(marked) {
		t.Fatal("marked error was not recognized")
	}
	if !errors.Is(marked, sentinel) {
		t.Fatalf("marked error does not preserve errors.Is: %v", marked)
	}
	if got := MarkSafeTransportError(marked); got != marked {
		t.Fatal("marking an already-marked error changed its identity")
	}
	if got := MarkSafeTransportError(nil); got != nil {
		t.Fatalf("MarkSafeTransportError(nil) = %v", got)
	}
}

func TestPermanentAndCancellationErrorsAreNotRetried(t *testing.T) {
	policy := testPolicy(t, 2, 250*time.Millisecond)
	for _, err := range []error{
		errors.New("permanent transport failure"),
		context.Canceled,
		context.DeadlineExceeded,
	} {
		if decision := policy.Decide(0, 0, nil, err, time.Time{}); decision.Retry {
			t.Fatalf("error %v unexpectedly retried", err)
		}
	}

	markedCancellation := MarkSafeTransportError(context.Canceled)
	if decision := policy.Decide(0, 0, nil, markedCancellation, time.Time{}); decision.Retry {
		t.Fatal("marked context cancellation unexpectedly retried")
	}
	markedDeadline := MarkSafeTransportError(context.DeadlineExceeded)
	if decision := policy.Decide(0, 0, nil, markedDeadline, time.Time{}); decision.Retry {
		t.Fatal("marked context deadline unexpectedly retried")
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
	if got := policy.RetryAfter(header, now); got != 5*time.Minute {
		t.Fatalf("bounded policy retry hint = %s", got)
	}
	if got := policy.Decide(0, 429, header, nil, now).Delay; got != 5*time.Minute {
		t.Fatalf("maximum retry delay = %s", got)
	}

	header = http.Header{"Retry-After-Ms": {"18446744073709551615"}}
	if got := policy.RetryAfter(header, now); got != 5*time.Minute {
		t.Fatalf("overflow-safe bounded policy retry hint = %s", got)
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

func TestMaximumDurationJitterDoesNotOverflow(t *testing.T) {
	policy, err := New(Config{
		MaxRetries: 1,
		BaseDelay:  time.Duration(math.MaxInt64),
		MaxDelay:   time.Duration(math.MaxInt64),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	decision := policy.Decide(0, http.StatusTooManyRequests, nil, nil, time.Unix(0, 0))
	if !decision.Retry {
		t.Fatal("maximum-duration policy did not retry")
	}
	if decision.Delay < 0 || decision.Delay > time.Duration(math.MaxInt64) {
		t.Fatalf("retry delay = %s, want a bounded non-negative duration", decision.Delay)
	}
}
