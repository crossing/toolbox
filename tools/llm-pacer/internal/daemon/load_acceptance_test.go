package daemon

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentRequestsStayConnectedAndArePaced(t *testing.T) {
	const (
		requestCount = 50
		maxInflight  = 3
		rpm          = 1500.0
	)
	paceInterval := time.Duration(float64(time.Minute) / rpm)

	var (
		active    atomic.Int64
		maxActive atomic.Int64
		startsMu  sync.Mutex
		starts    []time.Time
	)
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started := time.Now()
		startsMu.Lock()
		starts = append(starts, started)
		startsMu.Unlock()

		current := active.Add(1)
		defer active.Add(-1)
		updateMaximum(&maxActive, current)

		// Keep attempts overlapping long enough to exercise the inflight gate.
		time.Sleep(3 * paceInterval)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"fixture-load-response","choices":[]}`)
	}))
	defer upstreamServer.Close()

	cfg := daemonConfig(upstreamServer.URL)
	cfg.RPM = rpm
	cfg.MaxInflight = maxInflight
	cfg.QueueLimit = requestCount + maxInflight
	cfg.MaxQueuedBodyBytes = 1 << 20
	cfg.MaxRequestBodyBytes = 1 << 10
	daemon, err := New(cfg, fakeUpstreamKey, fakeLocalKey, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()

	proxyServer := httptest.NewServer(daemon.Handler())
	defer proxyServer.Close()
	transport := &http.Transport{
		Proxy:               nil,
		MaxIdleConns:        requestCount,
		MaxIdleConnsPerHost: requestCount,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}

	type result struct {
		status int
		err    error
	}
	ready := sync.WaitGroup{}
	ready.Add(requestCount)
	start := make(chan struct{})
	results := make(chan result, requestCount)
	for id := 0; id < requestCount; id++ {
		go func(id int) {
			body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":%q}]}`, fakeModelID, fmt.Sprintf("fixture request %d", id))
			request, requestErr := http.NewRequest(http.MethodPost, proxyServer.URL+"/v1/chat/completions", strings.NewReader(body))
			if requestErr != nil {
				ready.Done()
				results <- result{err: requestErr}
				return
			}
			request.Header.Set("Authorization", "Bearer "+fakeLocalKey)
			request.Header.Set("Content-Type", "application/json")
			ready.Done()
			<-start

			response, requestErr := client.Do(request)
			if requestErr != nil {
				results <- result{err: requestErr}
				return
			}
			_, readErr := io.Copy(io.Discard, response.Body)
			closeErr := response.Body.Close()
			if readErr != nil {
				results <- result{status: response.StatusCode, err: readErr}
				return
			}
			results <- result{status: response.StatusCode, err: closeErr}
		}(id)
	}
	ready.Wait()
	close(start)

	deadline := time.After(10 * time.Second)
	for completed := 0; completed < requestCount; completed++ {
		select {
		case got := <-results:
			if got.err != nil {
				t.Fatalf("request %d failed while queued or forwarding: %v", completed, got.err)
			}
			if got.status != http.StatusOK {
				t.Fatalf("request %d status = %d, want 200", completed, got.status)
			}
		case <-deadline:
			t.Fatalf("only %d of %d queued requests completed before the deadline", completed, requestCount)
		}
	}

	startsMu.Lock()
	observedStarts := append([]time.Time(nil), starts...)
	startsMu.Unlock()
	if len(observedStarts) != requestCount {
		t.Fatalf("upstream starts = %d, want %d", len(observedStarts), requestCount)
	}
	sort.Slice(observedStarts, func(i, j int) bool { return observedStarts[i].Before(observedStarts[j]) })
	// Handler timestamps occur after scheduler dispatch and can bunch locally
	// when one handler goroutine is descheduled. The full-span assertion is
	// insensitive to that observation jitter while still rejecting an unpaced
	// or materially over-rate batch. Deterministic scheduler tests separately
	// assert every exact adjacent dispatch interval and no catch-up bursts.
	expectedSpan := time.Duration(requestCount-1) * paceInterval
	observationAllowance := 3 * paceInterval
	minimumObservedSpan := expectedSpan - observationAllowance
	if observedSpan := observedStarts[len(observedStarts)-1].Sub(observedStarts[0]); observedSpan < minimumObservedSpan {
		t.Fatalf("50-request upstream start span = %s, want at least %s (configured interval=%s, observation allowance=%s)", observedSpan, minimumObservedSpan, paceInterval, observationAllowance)
	}
	if got := maxActive.Load(); got > maxInflight {
		t.Fatalf("maximum upstream concurrency = %d, configured limit = %d", got, maxInflight)
	}
	if got := maxActive.Load(); got < 2 {
		t.Fatalf("maximum upstream concurrency = %d; test did not exercise overlapping attempts", got)
	}
}

func updateMaximum(maximum *atomic.Int64, candidate int64) {
	for {
		current := maximum.Load()
		if candidate <= current || maximum.CompareAndSwap(current, candidate) {
			return
		}
	}
}
