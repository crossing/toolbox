package upstream

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testUpstreamToken = "fake-upstream-token"
	testLocalToken    = "fake-local-token"
)

func newTestClient(t *testing.T, baseURL string, configure func(*Config)) *Client {
	t.Helper()
	config := Config{
		BaseURL:               baseURL,
		BearerToken:           testUpstreamToken,
		ConnectTimeout:        time.Second,
		ResponseHeaderTimeout: 2 * time.Second,
		StreamIdleTimeout:     2 * time.Second,
		MaxInflight:           3,
	}
	if configure != nil {
		configure(&config)
	}
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func newTestRequest(t *testing.T, method, path, query string, headers http.Header, body []byte) *BufferedRequest {
	t.Helper()
	request, err := NewBufferedRequest(method, path, query, headers, body)
	if err != nil {
		t.Fatalf("NewBufferedRequest() error = %v", err)
	}
	return request
}

func closeResponse(t *testing.T, response *http.Response) {
	t.Helper()
	if response == nil || response.Body == nil {
		return
	}
	if err := response.Body.Close(); err != nil {
		t.Errorf("response Body.Close() error = %v", err)
	}
}

func TestTargetJoiningPreservesBasePathEscapedPathAndQuery(t *testing.T) {
	type observedTarget struct {
		escapedPath string
		rawQuery    string
		requestURI  string
	}
	observed := make(chan observedTarget, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		observed <- observedTarget{
			escapedPath: request.URL.EscapedPath(),
			rawQuery:    request.URL.RawQuery,
			requestURI:  request.RequestURI,
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := newTestClient(t, server.URL+"/gateway%2Ftenant/root/", nil)
	request := newTestRequest(
		t,
		http.MethodPost,
		"/v1/files/a%2Fb",
		"x=a%2Fb&x=two%20words",
		nil,
		nil,
	)
	response, err := client.Do(context.Background(), request)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	closeResponse(t, response)

	got := <-observed
	if want := "/gateway%2Ftenant/root/v1/files/a%2Fb"; got.escapedPath != want {
		t.Fatalf("escaped path = %q, want %q", got.escapedPath, want)
	}
	if want := "x=a%2Fb&x=two%20words"; got.rawQuery != want {
		t.Fatalf("raw query = %q, want %q", got.rawQuery, want)
	}
	if want := got.escapedPath + "?" + got.rawQuery; got.requestURI != want {
		t.Fatalf("RequestURI = %q, want %q", got.requestURI, want)
	}
}

func TestAuthorizationIsReplacedWithoutMutatingOrLeakingCallerInputs(t *testing.T) {
	type observedRequest struct {
		authorization string
		clientHeader  string
		body          string
	}
	observed := make(chan observedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		observed <- observedRequest{
			authorization: request.Header.Get("Authorization"),
			clientHeader:  request.Header.Get("X-Client"),
			body:          string(body),
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	headers := http.Header{
		"Authorization": {"Bearer " + testLocalToken},
		"X-Client":      {"original-header"},
	}
	body := []byte("original-body")
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", headers, body)
	if got := headers.Get("Authorization"); got != "Bearer "+testLocalToken {
		t.Fatalf("constructor mutated caller Authorization = %q", got)
	}

	// Mutations after construction must not alter the immutable snapshot.
	headers.Set("Authorization", "Bearer changed-local-token")
	headers.Set("X-Client", "changed-header")
	body[0] = 'X'

	client := newTestClient(t, server.URL, nil)
	response, err := client.Do(context.Background(), buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	closeResponse(t, response)

	got := <-observed
	if got.authorization != "Bearer "+testUpstreamToken {
		t.Fatalf("upstream Authorization = %q", got.authorization)
	}
	if got.clientHeader != "original-header" || got.body != "original-body" {
		t.Fatalf("upstream snapshot = %#v", got)
	}
	joined := got.authorization + got.clientHeader + got.body
	if strings.Contains(joined, testLocalToken) || strings.Contains(joined, "changed-local-token") {
		t.Fatalf("upstream request leaked a local token: %#v", got)
	}
	if got := headers.Get("Authorization"); got != "Bearer changed-local-token" {
		t.Fatalf("Do() mutated caller Authorization = %q", got)
	}
}

func TestHopByHopAndConnectionNominatedHeadersAreRemoved(t *testing.T) {
	observed := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		observed <- request.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	headers := http.Header{
		"Connection":          {"X-Hop, X-Second-Hop"},
		"X-Hop":               {"remove-me"},
		"X-Second-Hop":        {"remove-me-too"},
		"Keep-Alive":          {"timeout=5"},
		"Proxy-Authenticate":  {"fake"},
		"Proxy-Authorization": {"fake"},
		"Proxy-Connection":    {"keep-alive"},
		"Te":                  {"trailers"},
		"Trailer":             {"X-Trailer"},
		"Transfer-Encoding":   {"chunked"},
		"Upgrade":             {"websocket"},
		"Content-Length":      {"999"},
		"Host":                {"wrong.invalid"},
		"X-End-To-End":        {"preserve-me"},
	}
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", headers, []byte("{}"))
	client := newTestClient(t, server.URL, nil)
	response, err := client.Do(context.Background(), buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	closeResponse(t, response)

	got := <-observed
	for _, name := range []string{
		"Connection", "X-Hop", "X-Second-Hop", "Keep-Alive",
		"Proxy-Authenticate", "Proxy-Authorization", "Proxy-Connection",
		"Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		if value := got.Get(name); value != "" {
			t.Errorf("upstream %s = %q, want absent", name, value)
		}
	}
	if got.Get("X-End-To-End") != "preserve-me" {
		t.Fatalf("end-to-end header = %q", got.Get("X-End-To-End"))
	}
	if got.Get("Authorization") != "Bearer "+testUpstreamToken {
		t.Fatalf("Authorization = %q", got.Get("Authorization"))
	}
	if got := headers.Get("Connection"); got != "X-Hop, X-Second-Hop" {
		t.Fatalf("caller Connection header was mutated: %q", got)
	}
}

func TestBufferedRequestCanBeReplayedAcrossExplicitAttempts(t *testing.T) {
	var attempts atomic.Int32
	bodies := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		attempts.Add(1)
		body, _ := io.ReadAll(request.Body)
		bodies <- string(body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, nil)
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte(`{"model":"fake/model"}`))
	for attempt := 0; attempt < 2; attempt++ {
		response, err := client.Do(context.Background(), buffered)
		if err != nil {
			t.Fatalf("Do() attempt %d error = %v", attempt+1, err)
		}
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("attempt %d status = %d", attempt+1, response.StatusCode)
		}
		closeResponse(t, response)
	}

	if got := attempts.Load(); got != 2 {
		t.Fatalf("recorded attempts = %d, want 2", got)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if got := <-bodies; got != `{"model":"fake/model"}` {
			t.Fatalf("attempt %d body = %q", attempt+1, got)
		}
	}
}

func TestDoReturnsRawStatusHeadersAndIncrementalSSE(t *testing.T) {
	const firstChunk = "data: first\n\n"
	const secondChunk = "data: second\n\n"
	releaseSecond := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseSecond) }) }
	t.Cleanup(release)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Upstream", "raw-header")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.WriteString(w, firstChunk)
		flusher.Flush()
		<-releaseSecond
		_, _ = io.WriteString(w, secondChunk)
		flusher.Flush()
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, nil)
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte("{}"))
	response, err := client.Do(context.Background(), buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer closeResponse(t, response)
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := response.Header.Get("X-Upstream"); got != "raw-header" {
		t.Fatalf("X-Upstream = %q", got)
	}
	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q", got)
	}

	first := make([]byte, len(firstChunk))
	if _, err := io.ReadFull(response.Body, first); err != nil {
		t.Fatalf("read first SSE chunk: %v", err)
	}
	if string(first) != firstChunk {
		t.Fatalf("first SSE chunk = %q", string(first))
	}
	// The first chunk was readable while the handler was still blocked, proving
	// the response body was not buffered to completion.
	release()
	rest, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read remaining SSE: %v", err)
	}
	if string(rest) != secondChunk {
		t.Fatalf("remaining SSE = %q", string(rest))
	}
}

func TestResponseHeaderTimeoutCancelsDelayedUpstream(t *testing.T) {
	started := make(chan struct{})
	releaseHandler := make(chan struct{})
	var startOnce, releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }

	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		startOnce.Do(func() { close(started) })
		<-releaseHandler
	}))
	defer server.Close()
	defer release()

	client := newTestClient(t, server.URL, func(config *Config) {
		config.ResponseHeaderTimeout = 100 * time.Millisecond
	})
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte("{}"))

	startedAt := time.Now()
	_, err := client.Do(context.Background(), buffered)
	release()
	if err == nil {
		t.Fatal("Do() unexpectedly succeeded")
	}
	var networkError net.Error
	if !errors.As(err, &networkError) || !networkError.Timeout() {
		t.Fatalf("Do() error = %v, want timeout", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 2*time.Second {
		t.Fatalf("response header timeout took %s", elapsed)
	}
	select {
	case <-started:
	default:
		t.Fatal("upstream request was not recorded")
	}
}

func TestContextCancellationInterruptsDelayedHeaders(t *testing.T) {
	started := make(chan struct{})
	releaseHandler := make(chan struct{})
	var startOnce, releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }

	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		startOnce.Do(func() { close(started) })
		<-releaseHandler
	}))
	defer server.Close()
	defer release()

	client := newTestClient(t, server.URL, func(config *Config) {
		config.ResponseHeaderTimeout = 5 * time.Second
	})
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte("{}"))
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := client.Do(ctx, buffered)
		result <- err
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Do() error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Do() remained blocked after context cancellation")
	}
	release()
}

func TestResponseBodyIdleTimeoutClosesAndUnblocksStream(t *testing.T) {
	const firstChunk = "data: first\n\n"
	requestCancelled := make(chan struct{})
	releaseHandler := make(chan struct{})
	var cancelledOnce, releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	t.Cleanup(release)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		flusher := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, firstChunk)
		flusher.Flush()
		select {
		case <-request.Context().Done():
			cancelledOnce.Do(func() { close(requestCancelled) })
		case <-releaseHandler:
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, func(config *Config) {
		config.StreamIdleTimeout = 100 * time.Millisecond
	})
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte("{}"))
	response, err := client.Do(context.Background(), buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer closeResponse(t, response)

	body, err := io.ReadAll(response.Body)
	if !errors.Is(err, ErrResponseBodyIdleTimeout) {
		t.Fatalf("ReadAll() error = %v, want ErrResponseBodyIdleTimeout", err)
	}
	if string(body) != firstChunk {
		t.Fatalf("body before idle timeout = %q", string(body))
	}
	select {
	case <-requestCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("idle timeout did not close the upstream response body")
	}
}

func TestContextCancellationClosesBlockedResponseBodyRead(t *testing.T) {
	requestCancelled := make(chan struct{})
	releaseHandler := make(chan struct{})
	var cancelledOnce, releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	t.Cleanup(release)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "x")
		flusher.Flush()
		select {
		case <-request.Context().Done():
			cancelledOnce.Do(func() { close(requestCancelled) })
		case <-releaseHandler:
		}
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, nil)
	buffered := newTestRequest(t, http.MethodPost, "/v1/chat/completions", "", nil, []byte("{}"))
	ctx, cancel := context.WithCancel(context.Background())
	response, err := client.Do(ctx, buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer closeResponse(t, response)

	first := make([]byte, 1)
	if _, err := io.ReadFull(response.Body, first); err != nil || string(first) != "x" {
		t.Fatalf("initial ReadFull() = %q, %v", string(first), err)
	}
	readResult := make(chan error, 1)
	go func() {
		_, err := response.Body.Read(make([]byte, 1))
		readResult <- err
	}()
	cancel()

	select {
	case err := <-readResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("blocked Read() error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("response body Read remained blocked after cancellation")
	}
	select {
	case <-requestCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream did not observe response-body cancellation")
	}
}

func TestDoRecordsExactlyOneAttemptAndDoesNotFollowRedirects(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		attempts.Add(1)
		if request.URL.Path == "/second" {
			t.Error("transport followed an upstream redirect")
		}
		w.Header().Set("Location", "/second")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	client := newTestClient(t, server.URL, nil)
	buffered := newTestRequest(t, http.MethodGet, "/first", "", nil, nil)
	response, err := client.Do(context.Background(), buffered)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer closeResponse(t, response)
	if response.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := attempts.Load(); got != 1 {
		t.Fatalf("recorded attempts = %d, want exactly 1", got)
	}
}

func TestTransportIsBoundedAndPreservesWireEncoding(t *testing.T) {
	client := newTestClient(t, "https://example.invalid/base", func(config *Config) {
		config.ConnectTimeout = 3 * time.Second
		config.ResponseHeaderTimeout = 4 * time.Second
		config.MaxInflight = 7
	})
	transport := client.transport
	if transport.MaxConnsPerHost != 7 || transport.MaxIdleConnsPerHost != 7 || transport.MaxIdleConns != 7 {
		t.Fatalf("connection bounds = total:%d idle-host:%d idle:%d", transport.MaxConnsPerHost, transport.MaxIdleConnsPerHost, transport.MaxIdleConns)
	}
	if transport.ResponseHeaderTimeout != 4*time.Second || transport.TLSHandshakeTimeout != 3*time.Second {
		t.Fatalf("transport timeouts = header:%s TLS:%s", transport.ResponseHeaderTimeout, transport.TLSHandshakeTimeout)
	}
	if !transport.DisableCompression {
		t.Fatal("DisableCompression = false, want wire-fidelity mode")
	}
}

func TestValidationRejectsUnsafeOrUnboundedConfiguration(t *testing.T) {
	valid := Config{
		BaseURL:               "https://example.invalid/base",
		BearerToken:           testUpstreamToken,
		ConnectTimeout:        time.Second,
		ResponseHeaderTimeout: time.Second,
		StreamIdleTimeout:     time.Second,
		MaxInflight:           1,
	}
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "relative base", mutate: func(config *Config) { config.BaseURL = "/relative" }},
		{name: "base query", mutate: func(config *Config) { config.BaseURL += "?secret=no" }},
		{name: "base userinfo", mutate: func(config *Config) { config.BaseURL = "https://user@example.invalid" }},
		{name: "empty token", mutate: func(config *Config) { config.BearerToken = "" }},
		{name: "header injection token", mutate: func(config *Config) { config.BearerToken = "fake\r\nX-Leak: yes" }},
		{name: "connect timeout", mutate: func(config *Config) { config.ConnectTimeout = 0 }},
		{name: "header timeout", mutate: func(config *Config) { config.ResponseHeaderTimeout = 0 }},
		{name: "idle timeout", mutate: func(config *Config) { config.StreamIdleTimeout = 0 }},
		{name: "max inflight", mutate: func(config *Config) { config.MaxInflight = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := valid
			test.mutate(&config)
			if _, err := NewClient(config); err == nil {
				t.Fatal("NewClient() unexpectedly succeeded")
			}
		})
	}
}

func TestBufferedRequestValidation(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		query  string
	}{
		{name: "invalid method", method: "BAD METHOD", path: "/v1/test"},
		{name: "relative path", method: http.MethodGet, path: "v1/test"},
		{name: "invalid escape", method: http.MethodGet, path: "/v1/%zz"},
		{name: "query in path", method: http.MethodGet, path: "/v1/test?x=1"},
		{name: "leading query marker", method: http.MethodGet, path: "/v1/test", query: "?x=1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewBufferedRequest(test.method, test.path, test.query, nil, nil); err == nil {
				t.Fatal("NewBufferedRequest() unexpectedly succeeded")
			}
		})
	}
}
