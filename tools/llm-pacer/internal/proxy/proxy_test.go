package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/retry"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/scheduler"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/upstream"
)

const (
	allowedModel      = "vendor/allowed"
	fakeLocalToken    = "LOCAL_TOKEN_SHOULD_NOT_LEAK_7df1"
	fakeUpstreamToken = "UPSTREAM_TOKEN_SHOULD_NOT_LEAK_8ae2"
	sensitivePrompt   = "PROMPT_SHOULD_NOT_LEAK_3bc4"
	sensitiveResponse = "RESPONSE_SHOULD_NOT_LEAK_9ca5"
)

type fakeDoer struct {
	mu      sync.Mutex
	calls   int
	perform func(context.Context, *upstream.BufferedRequest, int) (*http.Response, error)
}

func (d *fakeDoer) Do(ctx context.Context, request *upstream.BufferedRequest) (*http.Response, error) {
	d.mu.Lock()
	d.calls++
	call := d.calls
	perform := d.perform
	d.mu.Unlock()
	return perform(ctx, request, call)
}

func (d *fakeDoer) Calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

type handlerOptions struct {
	doer            Doer
	logger          *slog.Logger
	sleep           func(context.Context, time.Duration) error
	maxRequestBytes int64
	maxAdmitted     int
	maxRetained     int64
	maxRetries      int
	rpm             float64
}

func newTestHandler(t *testing.T, options handlerOptions) (*Handler, *scheduler.Scheduler) {
	t.Helper()
	if options.maxRequestBytes == 0 {
		options.maxRequestBytes = 1 << 20
	}
	if options.maxAdmitted == 0 {
		options.maxAdmitted = 16
	}
	if options.maxRetained == 0 {
		options.maxRetained = 4 << 20
	}
	if options.rpm == 0 {
		options.rpm = 100_000_000
	}
	if options.doer == nil {
		t.Fatal("test upstream Doer is required")
	}

	models := &catalog.Catalog{Models: map[string]catalog.Model{allowedModel: {}}}
	if err := models.Validate(); err != nil {
		t.Fatalf("catalog.Validate() error = %v", err)
	}
	s, err := scheduler.New(scheduler.Config{
		RequestsPerMinute:    options.rpm,
		MinRequestsPerMinute: 1,
		MaxInflightAttempts:  3,
		MaxAdmittedRequests:  options.maxAdmitted,
		MaxRetainedBodyBytes: options.maxRetained,
	})
	if err != nil {
		t.Fatalf("scheduler.New() error = %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("scheduler.Close() error = %v", err)
		}
	})
	policy, err := retry.New(retry.Config{
		MaxRetries: options.maxRetries,
		BaseDelay:  time.Nanosecond,
		MaxDelay:   10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("retry.New() error = %v", err)
	}
	if options.sleep == nil {
		options.sleep = func(ctx context.Context, _ time.Duration) error {
			return ctx.Err()
		}
	}
	handler, err := New(Config{
		Catalog:             models,
		Scheduler:           s,
		Upstream:            options.doer,
		RetryPolicy:         policy,
		MaxRequestBodyBytes: options.maxRequestBytes,
		Logger:              options.logger,
		Sleep:               options.sleep,
	})
	if err != nil {
		t.Fatalf("proxy.New() error = %v", err)
	}
	return handler, s
}

func inferenceRequest(ctx context.Context, body string) *http.Request {
	return inferenceRequestFor(ctx, http.MethodPost, "/v1/chat/completions?trace=1", body, "application/json")
}

func inferenceRequestFor(ctx context.Context, method, target, body, contentType string) *http.Request {
	request := httptest.NewRequest(method, "http://llm-pacer.invalid"+target, strings.NewReader(body))
	request = request.WithContext(ctx)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("Authorization", "Bearer "+fakeLocalToken)
	request.Header.Set("X-Request-Id", "test-request-id")
	return request
}

func multipartInferenceBody(t *testing.T, models ...string) (string, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, model := range models {
		if err := writer.WriteField("model", model); err != nil {
			t.Fatalf("write multipart model: %v", err)
		}
	}
	file, err := writer.CreateFormFile("file", "fixture.wav")
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := file.Write([]byte("obviously-fake-audio")); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart body: %v", err)
	}
	return body.String(), writer.FormDataContentType()
}

func modelBody(extra string) string {
	if extra == "" {
		return fmt.Sprintf(`{"model":%q}`, allowedModel)
	}
	return fmt.Sprintf(`{"model":%q,%s}`, allowedModel, extra)
}

func response(status int, body string, headers http.Header) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	return &http.Response{
		StatusCode: status,
		Header:     headers,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func assertLocalError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, status, recorder.Body.String())
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode local error: %v; body=%s", err, recorder.Body.String())
	}
	if payload.Error.Code != code {
		t.Fatalf("error code = %q, want %q", payload.Error.Code, code)
	}
}

func TestAllowedModelForwardsUpstreamStatusHeadersAndBody(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusAccepted, `{"accepted":true}`, http.Header{"X-Upstream": {"mock"}}), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody(`"input":"hello"`)))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusAccepted)
	}
	if got := recorder.Body.String(); got != `{"accepted":true}` {
		t.Fatalf("body = %q", got)
	}
	if got := recorder.Header().Get("X-Upstream"); got != "mock" {
		t.Fatalf("X-Upstream = %q, want mock", got)
	}
	if doer.Calls() != 1 {
		t.Fatalf("upstream calls = %d, want 1", doer.Calls())
	}
}

func TestInvalidInferenceRequestsNeverReachUpstream(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusOK, "unexpected", nil), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer})
	tests := []struct {
		name     string
		body     string
		encoding string
		code     string
	}{
		{name: "missing model", body: `{}`, code: "proxy_model_required"},
		{name: "disallowed model", body: `{"model":"vendor/denied"}`, code: "proxy_model_not_allowed"},
		{name: "model has wrong type", body: `{"model":42}`, code: "proxy_invalid_model"},
		{name: "model has surrounding whitespace", body: `{"model":" vendor/allowed "}`, code: "proxy_invalid_model"},
		{name: "compressed inference", body: modelBody(`"input":"compressed"`), encoding: "gzip", code: "proxy_invalid_request"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := inferenceRequest(context.Background(), test.body)
			if test.encoding != "" {
				request.Header.Set("Content-Encoding", test.encoding)
			}
			handler.ServeHTTP(recorder, request)
			assertLocalError(t, recorder, http.StatusBadRequest, test.code)
		})
	}
	if doer.Calls() != 0 {
		t.Fatalf("invalid requests made %d upstream calls", doer.Calls())
	}
}

func TestJSONInferenceRoutePolicy(t *testing.T) {
	tests := []struct {
		name         string
		method       string
		path         string
		body         string
		contentType  string
		contentTypes []string
		encoding     string
		wantStatus   int
		wantCode     string
		wantCalls    int
	}{
		{name: "chat completions", method: http.MethodPost, path: "/v1/chat/completions", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "legacy completions", method: http.MethodPost, path: "/v1/completions", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "embeddings", method: http.MethodPost, path: "/v1/embeddings", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "responses", method: http.MethodPost, path: "/v1/responses", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "moderations", method: http.MethodPost, path: "/v1/moderations", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "image generations", method: http.MethodPost, path: "/v1/images/generations", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "audio speech", method: http.MethodPost, path: "/v1/audio/speech", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "vendor extension plus json", method: http.MethodPost, path: "/v1/vendor/generate", body: modelBody(""), contentType: "application/vnd.vendor+json", wantStatus: http.StatusOK, wantCalls: 1},
		{name: "vendor extension no content type", method: http.MethodPost, path: "/v1/vendor/generate", body: modelBody(""), wantStatus: http.StatusOK, wantCalls: 1},
		{name: "unknown json without model", method: http.MethodPost, path: "/v1/vendor/generate", body: `{}`, contentType: "application/json", wantStatus: http.StatusBadRequest, wantCode: "proxy_model_required"},
		{name: "duplicate json model", method: http.MethodPost, path: "/v1/vendor/generate", body: fmt.Sprintf(`{"model":%q,"model":%q}`, allowedModel, allowedModel), contentType: "application/json", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_model"},
		{name: "opaque body", method: http.MethodPost, path: "/v1/vendor/generate", body: modelBody(""), contentType: "application/octet-stream", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "compressed json", method: http.MethodPost, path: "/v1/vendor/generate", body: modelBody(""), contentType: "application/json", encoding: "gzip", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "known management route", method: http.MethodPost, path: "/v1/files", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusNotFound, wantCode: "proxy_not_found"},
		{name: "case variant management route", method: http.MethodPost, path: "/v1/FiLeS", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusNotFound, wantCode: "proxy_not_found"},
		{name: "repeated slash management route", method: http.MethodPost, path: "/v1//files", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "ambiguous content type", method: http.MethodPost, path: "/v1/vendor/generate", body: modelBody(""), contentTypes: []string{"application/json", "application/octet-stream"}, wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "non post inference", method: http.MethodGet, path: "/v1/vendor/generate", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusMethodNotAllowed, wantCode: "proxy_method_not_allowed"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
				return response(http.StatusOK, `{"ok":true}`, nil), nil
			}}
			handler, _ := newTestHandler(t, handlerOptions{doer: doer})
			request := inferenceRequestFor(context.Background(), test.method, test.path, test.body, test.contentType)
			for _, contentType := range test.contentTypes {
				request.Header.Add("Content-Type", contentType)
			}
			if test.encoding != "" {
				request.Header.Set("Content-Encoding", test.encoding)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if test.wantCode != "" {
				assertLocalError(t, recorder, test.wantStatus, test.wantCode)
			} else if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if doer.Calls() != test.wantCalls {
				t.Fatalf("upstream calls = %d, want %d", doer.Calls(), test.wantCalls)
			}
		})
	}
}

func TestMultipartInferenceRoutePolicy(t *testing.T) {
	validBody, validContentType := multipartInferenceBody(t, allowedModel)
	missingBody, missingContentType := multipartInferenceBody(t)
	disallowedBody, disallowedContentType := multipartInferenceBody(t, "vendor/denied")
	duplicateBody, duplicateContentType := multipartInferenceBody(t, allowedModel, allowedModel)
	tests := []struct {
		name        string
		path        string
		body        string
		contentType string
		wantStatus  int
		wantCode    string
		wantCalls   int
	}{
		{name: "audio transcriptions", path: "/v1/audio/transcriptions", body: validBody, contentType: validContentType, wantStatus: http.StatusOK, wantCalls: 1},
		{name: "audio translations", path: "/v1/audio/translations", body: validBody, contentType: validContentType, wantStatus: http.StatusOK, wantCalls: 1},
		{name: "image edits", path: "/v1/images/edits", body: validBody, contentType: validContentType, wantStatus: http.StatusOK, wantCalls: 1},
		{name: "image variations", path: "/v1/images/variations", body: validBody, contentType: validContentType, wantStatus: http.StatusOK, wantCalls: 1},
		{name: "missing model", path: "/v1/audio/transcriptions", body: missingBody, contentType: missingContentType, wantStatus: http.StatusBadRequest, wantCode: "proxy_model_required"},
		{name: "disallowed model", path: "/v1/audio/transcriptions", body: disallowedBody, contentType: disallowedContentType, wantStatus: http.StatusBadRequest, wantCode: "proxy_model_not_allowed"},
		{name: "duplicate model", path: "/v1/audio/transcriptions", body: duplicateBody, contentType: duplicateContentType, wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_model"},
		{name: "json on multipart route", path: "/v1/audio/transcriptions", body: modelBody(""), contentType: "application/json", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "multipart on unknown route", path: "/v1/vendor/generate", body: validBody, contentType: validContentType, wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
		{name: "missing boundary", path: "/v1/audio/transcriptions", body: validBody, contentType: "multipart/form-data", wantStatus: http.StatusBadRequest, wantCode: "proxy_invalid_request"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
				return response(http.StatusOK, `{"ok":true}`, nil), nil
			}}
			handler, _ := newTestHandler(t, handlerOptions{doer: doer})
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, inferenceRequestFor(context.Background(), http.MethodPost, test.path, test.body, test.contentType))

			if test.wantCode != "" {
				assertLocalError(t, recorder, test.wantStatus, test.wantCode)
			} else if recorder.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, test.wantStatus, recorder.Body.String())
			}
			if doer.Calls() != test.wantCalls {
				t.Fatalf("upstream calls = %d, want %d", doer.Calls(), test.wantCalls)
			}
		})
	}
}

func TestEncodedOrUnsafePathSegmentsNeverReachUpstream(t *testing.T) {
	paths := []string{
		"/v1/../files",
		"/v1/%2e%2e/files",
		"/v1/%2E./files",
		"/v1/%252e%252e/files",
		"/v1/safe/%2e/route",
		"/v1/safe/%2e%2e%2fadmin",
		"/v1/%66iles",
		"/v1/%2566iles",
		"/v1/vendor%2fgenerate",
		"/v1/vendor\\generate",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
				return response(http.StatusOK, "unexpected", nil), nil
			}}
			handler, _ := newTestHandler(t, handlerOptions{doer: doer})
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, inferenceRequestFor(context.Background(), http.MethodPost, path, modelBody(""), "application/json"))

			assertLocalError(t, recorder, http.StatusBadRequest, "proxy_invalid_request")
			if doer.Calls() != 0 {
				t.Fatalf("traversal path made %d upstream calls", doer.Calls())
			}
		})
	}
}

func TestRequestBodyLimitRejectsBeforeUpstream(t *testing.T) {
	body := modelBody(`"input":"body exceeds limit"`)
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusOK, "unexpected", nil), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRequestBytes: int64(len(body) - 1)})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), body))

	assertLocalError(t, recorder, http.StatusRequestEntityTooLarge, "proxy_request_too_large")
	if doer.Calls() != 0 {
		t.Fatalf("oversized request made %d upstream calls", doer.Calls())
	}
}

type gatedRequestReader struct {
	reader  *strings.Reader
	entered chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (reader *gatedRequestReader) Read(destination []byte) (int, error) {
	reader.once.Do(func() { close(reader.entered) })
	<-reader.release
	return reader.reader.Read(destination)
}

func TestUnknownLengthUploadReservesQueueCapacityBeforeRead(t *testing.T) {
	const (
		maximumRequest = int64(80)
		maximumQueued  = int64(100)
	)
	release := make(chan struct{})
	entered := make(chan struct{})
	body := modelBody("")
	slowBody := &gatedRequestReader{
		reader:  strings.NewReader(body),
		entered: entered,
		release: release,
	}
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusOK, `{"ok":true}`, nil), nil
	}}
	handler, scheduled := newTestHandler(t, handlerOptions{
		doer:            doer,
		maxRequestBytes: maximumRequest,
		maxRetained:     maximumQueued,
	})

	first := httptest.NewRequest(http.MethodPost, "http://llm-pacer.invalid/v1/chat/completions", slowBody)
	first.ContentLength = -1
	first.Header.Set("Content-Type", "application/json")
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, first)
		firstDone <- recorder
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("unknown-length request did not begin its body read")
	}
	snapshot := scheduled.Snapshot()
	if snapshot.AdmittedRequests != 1 || snapshot.RetainedBodyBytes != maximumRequest {
		close(release)
		t.Fatalf("pre-read reservation = %+v", snapshot)
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, inferenceRequest(context.Background(), body))
	assertLocalError(t, second, http.StatusTooManyRequests, "proxy_queue_full")
	if doer.Calls() != 0 {
		close(release)
		t.Fatalf("overflow reached upstream %d times before slow upload completed", doer.Calls())
	}

	close(release)
	select {
	case completed := <-firstDone:
		if completed.Code != http.StatusOK {
			t.Fatalf("slow upload completion status = %d", completed.Code)
		}
	case <-time.After(time.Second):
		t.Fatal("slow upload did not finish after release")
	}
	snapshot = scheduled.Snapshot()
	if snapshot.AdmittedRequests != 0 || snapshot.RetainedBodyBytes != 0 {
		t.Fatalf("slow upload leaked reservation: %+v", snapshot)
	}
}

func TestQueueOverflowReturnsLocalRetryHints(t *testing.T) {
	body := modelBody(`"input":"retained while upstream blocks"`)
	tests := []struct {
		name        string
		maxAdmitted int
		maxRetained int64
	}{
		{name: "request count", maxAdmitted: 1, maxRetained: 1 << 20},
		{name: "retained bytes", maxAdmitted: 4, maxRetained: int64(len(body)*2 - 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			entered := make(chan struct{}, 2)
			release := make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unblock()
			doer := &fakeDoer{perform: func(ctx context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
				entered <- struct{}{}
				select {
				case <-release:
					return response(http.StatusOK, `{"ok":true}`, nil), nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}}
			handler, _ := newTestHandler(t, handlerOptions{
				doer:            doer,
				maxAdmitted:     test.maxAdmitted,
				maxRetained:     test.maxRetained,
				maxRequestBytes: int64(len(body) + 1),
			})

			firstDone := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, inferenceRequest(context.Background(), body))
				firstDone <- recorder
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("first request did not enter upstream")
			}

			secondDone := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, inferenceRequest(context.Background(), body))
				secondDone <- recorder
			}()
			var rejected *httptest.ResponseRecorder
			select {
			case rejected = <-secondDone:
			case <-time.After(time.Second):
				unblock()
				t.Fatal("overflow request did not return promptly")
			}
			assertLocalError(t, rejected, http.StatusTooManyRequests, "proxy_queue_full")
			if rejected.Header().Get("Retry-After") == "" || rejected.Header().Get("retry-after-ms") == "" {
				t.Fatalf("retry headers missing: %#v", rejected.Header())
			}

			unblock()
			select {
			case first := <-firstDone:
				if first.Code != http.StatusOK {
					t.Fatalf("first request status = %d", first.Code)
				}
			case <-time.After(time.Second):
				t.Fatal("first request did not finish after release")
			}
			if doer.Calls() != 1 {
				t.Fatalf("upstream calls = %d, want 1", doer.Calls())
			}
		})
	}
}

func TestTransient503And429RetryAndSlowAdaptiveRate(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, call int) (*http.Response, error) {
		switch call {
		case 1:
			return response(http.StatusServiceUnavailable, "try again", nil), nil
		case 2:
			return response(http.StatusTooManyRequests, "paced", http.Header{"retry-after-ms": {"1"}}), nil
		default:
			return response(http.StatusOK, `{"done":true}`, nil), nil
		}
	}}
	var sleepMu sync.Mutex
	var sleeps []time.Duration
	handler, s := newTestHandler(t, handlerOptions{
		doer:       doer,
		maxRetries: 3,
		sleep: func(ctx context.Context, delay time.Duration) error {
			sleepMu.Lock()
			sleeps = append(sleeps, delay)
			sleepMu.Unlock()
			return ctx.Err()
		},
	})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"done":true}` {
		t.Fatalf("final response = %d %q", recorder.Code, recorder.Body.String())
	}
	if doer.Calls() != 3 {
		t.Fatalf("upstream calls = %d, want 3", doer.Calls())
	}
	sleepMu.Lock()
	if len(sleeps) != 2 {
		t.Fatalf("retry sleeps = %v, want two", sleeps)
	}
	sleepMu.Unlock()
	snapshot := s.Snapshot()
	if snapshot.EffectiveRPM >= snapshot.ConfiguredRPM || !snapshot.BackingOff {
		t.Fatalf("429 did not slow adaptive rate: %+v", snapshot)
	}
}

func TestRetryAfterHintPassedToSchedulerIsBounded(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusTooManyRequests, "limited", http.Header{
			"Retry-After-Ms": {"18446744073709551615"},
		}), nil
	}}
	handler, scheduled := newTestHandler(t, handlerOptions{doer: doer})
	recorder := httptest.NewRecorder()
	started := time.Now()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", recorder.Code)
	}
	hint := scheduled.Snapshot().NotBefore.Sub(started)
	if hint <= 0 || hint > 100*time.Millisecond {
		t.Fatalf("scheduler retry hint = %s, want positive policy-bounded delay", hint)
	}
}

func TestMaximumRetryBound(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusServiceUnavailable, "still unavailable", nil), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRetries: 2})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

	if doer.Calls() != 3 {
		t.Fatalf("upstream calls = %d, want initial plus two retries", doer.Calls())
	}
	if recorder.Code != http.StatusServiceUnavailable || recorder.Body.String() != "still unavailable" {
		t.Fatalf("terminal response = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestOnlyExplicitlySafeTransportFailureIsRetried(t *testing.T) {
	t.Run("marked pre-request failure", func(t *testing.T) {
		doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, call int) (*http.Response, error) {
			if call == 1 {
				return nil, retry.MarkSafeTransportError(errors.New("fixture pre-request dial failure"))
			}
			return response(http.StatusOK, `{"retried":true}`, nil), nil
		}}
		handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRetries: 2})
		recorder := httptest.NewRecorder()

		handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

		if doer.Calls() != 2 || recorder.Code != http.StatusOK {
			t.Fatalf("safe transport retry calls=%d status=%d body=%q", doer.Calls(), recorder.Code, recorder.Body.String())
		}
	})

	t.Run("ambiguous failure", func(t *testing.T) {
		doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
			return nil, errors.New("fixture ambiguous post-write failure")
		}}
		handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRetries: 2})
		recorder := httptest.NewRecorder()

		handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

		if doer.Calls() != 1 {
			t.Fatalf("ambiguous transport calls = %d, want 1", doer.Calls())
		}
		assertLocalError(t, recorder, http.StatusBadGateway, "proxy_upstream_error")
	})
}

func TestNonRetryable4xxPassesThrough(t *testing.T) {
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusUnprocessableEntity, `{"error":"invalid input"}`, nil), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRetries: 4})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

	if doer.Calls() != 1 {
		t.Fatalf("upstream calls = %d, want 1", doer.Calls())
	}
	if recorder.Code != http.StatusUnprocessableEntity || recorder.Body.String() != `{"error":"invalid input"}` {
		t.Fatalf("response = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestResponseHopByHopHeadersAreStripped(t *testing.T) {
	headers := http.Header{
		"Connection":        {"X-Remove-Me, Keep-Alive"},
		"X-Remove-Me":       {"secret-hop-value"},
		"Keep-Alive":        {"timeout=5"},
		"Proxy-Connection":  {"keep-alive"},
		"Transfer-Encoding": {"chunked"},
		"Upgrade":           {"websocket"},
		"X-End-To-End":      {"preserved"},
	}
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return response(http.StatusOK, "ok", headers), nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

	for _, name := range []string{"Connection", "X-Remove-Me", "Keep-Alive", "Proxy-Connection", "Transfer-Encoding", "Upgrade"} {
		if got := recorder.Header().Get(name); got != "" {
			t.Errorf("response retained hop-by-hop header %s=%q", name, got)
		}
	}
	if got := recorder.Header().Get("X-End-To-End"); got != "preserved" {
		t.Errorf("X-End-To-End = %q", got)
	}
}

type stagedBody struct {
	first   []byte
	second  []byte
	release <-chan struct{}
	step    int
}

func (b *stagedBody) Read(destination []byte) (int, error) {
	switch b.step {
	case 0:
		b.step++
		return copy(destination, b.first), nil
	case 1:
		<-b.release
		b.step++
		return copy(destination, b.second), nil
	default:
		return 0, io.EOF
	}
}

func (*stagedBody) Close() error { return nil }

type flushRecorder struct {
	header  http.Header
	mu      sync.Mutex
	code    int
	body    bytes.Buffer
	flushed chan struct{}
	once    sync.Once
}

func newFlushRecorder() *flushRecorder {
	return &flushRecorder{header: make(http.Header), flushed: make(chan struct{})}
}

func (w *flushRecorder) Header() http.Header { return w.header }

func (w *flushRecorder) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.code == 0 {
		w.code = status
	}
}

func (w *flushRecorder) Write(body []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.body.Write(body)
}

func (w *flushRecorder) Flush() { w.once.Do(func() { close(w.flushed) }) }

func (w *flushRecorder) snapshot() (int, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.code, w.body.String()
}

func TestSSEFlushesIncrementallyBeforeEOF(t *testing.T) {
	release := make(chan struct{})
	body := &stagedBody{
		first:   []byte("data: first\n\n"),
		second:  []byte("data: second\n\n"),
		release: release,
	}
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"text/event-stream; charset=utf-8"}},
			Body:       body,
		}, nil
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer})
	writer := newFlushRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(writer, inferenceRequest(context.Background(), modelBody(`"stream":true`)))
		close(done)
	}()

	select {
	case <-writer.flushed:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("first SSE chunk was not flushed")
	}
	if code, got := writer.snapshot(); code != http.StatusOK || got != "data: first\n\n" {
		close(release)
		t.Fatalf("pre-EOF response = %d %q", code, got)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("SSE response did not finish")
	}
	if _, got := writer.snapshot(); got != "data: first\n\ndata: second\n\n" {
		t.Fatalf("complete SSE body = %q", got)
	}
}

type failingReadCloser struct {
	payload []byte
	err     error
}

func (r *failingReadCloser) Read(destination []byte) (int, error) {
	return copy(destination, r.payload), r.err
}
func (*failingReadCloser) Close() error { return nil }

type committedFailureBody struct {
	sent bool
}

func (body *committedFailureBody) Read(destination []byte) (int, error) {
	if !body.sent {
		body.sent = true
		return copy(destination, []byte("data: partial\n\n")), nil
	}
	return 0, errors.New("fixture stream interrupted after commit")
}

func (*committedFailureBody) Close() error { return nil }

func TestCommittedStreamFailureDoesNotCountTowardAdaptiveRecovery(t *testing.T) {
	const configuredRPM = 1_000_000.0
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, call int) (*http.Response, error) {
		switch call {
		case 1:
			return response(http.StatusTooManyRequests, "limited", nil), nil
		case 21:
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"text/event-stream"}},
				Body:       &committedFailureBody{},
			}, nil
		default:
			return response(http.StatusOK, `{"ok":true}`, nil), nil
		}
	}}
	handler, scheduled := newTestHandler(t, handlerOptions{doer: doer, rpm: configuredRPM})

	for call := 1; call <= 22; call++ {
		handler.ServeHTTP(httptest.NewRecorder(), inferenceRequest(context.Background(), modelBody("")))
	}

	want := configuredRPM / scheduler.RateLimitSlowdownFactor
	if got := scheduled.Snapshot().EffectiveRPM; got != want {
		t.Fatalf("effective RPM after interrupted stream = %f, want %f", got, want)
	}
}

func TestFirstResponseReadFailureFailsClosedBeforeCommit(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		maxRetries int
		payload    string
		wantCalls  int
	}{
		{name: "successful status is not unsafely replayed", status: http.StatusOK, maxRetries: 3, wantCalls: 1},
		{name: "data and error from first read is not committed", status: http.StatusOK, maxRetries: 3, payload: "partial upstream response", wantCalls: 1},
		{name: "non retryable client error", status: http.StatusUnprocessableEntity, maxRetries: 3, wantCalls: 1},
		{name: "exhausted server error", status: http.StatusServiceUnavailable, maxRetries: 1, wantCalls: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
				return &http.Response{
					StatusCode: test.status,
					Header:     http.Header{"X-Upstream-Attempt": {"must-not-commit"}},
					Body: &failingReadCloser{
						payload: []byte(test.payload),
						err:     errors.New("early response read failed"),
					},
				}, nil
			}}
			handler, _ := newTestHandler(t, handlerOptions{doer: doer, maxRetries: test.maxRetries})
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody("")))

			if doer.Calls() != test.wantCalls {
				t.Fatalf("upstream calls = %d, want %d", doer.Calls(), test.wantCalls)
			}
			assertLocalError(t, recorder, http.StatusBadGateway, "proxy_upstream_error")
			if recorder.Header().Get("X-Upstream-Attempt") != "" || strings.Contains(recorder.Body.String(), test.payload) && test.payload != "" {
				t.Fatalf("response committed failed upstream read: headers=%#v body=%q", recorder.Header(), recorder.Body.String())
			}
		})
	}
}

func TestClientCancellationCancelsActiveUpstreamAndReleasesAdmission(t *testing.T) {
	entered := make(chan struct{})
	canceled := make(chan error, 1)
	doer := &fakeDoer{perform: func(ctx context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		close(entered)
		<-ctx.Done()
		canceled <- ctx.Err()
		return nil, ctx.Err()
	}}
	handler, s := newTestHandler(t, handlerOptions{doer: doer, maxRetries: 4})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), inferenceRequest(ctx, modelBody("")))
		close(done)
	}()

	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("request did not enter upstream")
	}
	cancel()
	select {
	case err := <-canceled:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("upstream context error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upstream did not observe client cancellation")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not return after cancellation")
	}
	snapshot := s.Snapshot()
	if snapshot.ActiveAttempts != 0 || snapshot.AdmittedRequests != 0 || snapshot.RetainedBodyBytes != 0 {
		t.Fatalf("cancellation leaked scheduler capacity: %+v", snapshot)
	}
}

func TestLogsAndLocalErrorsExcludeSecretsAndPayloads(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	doer := &fakeDoer{perform: func(_ context.Context, _ *upstream.BufferedRequest, _ int) (*http.Response, error) {
		return nil, fmt.Errorf("mock dial failure: %s %s", fakeUpstreamToken, sensitiveResponse)
	}}
	handler, _ := newTestHandler(t, handlerOptions{doer: doer, logger: logger})
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, inferenceRequest(context.Background(), modelBody(fmt.Sprintf(`"prompt":%q`, sensitivePrompt))))

	assertLocalError(t, recorder, http.StatusBadGateway, "proxy_upstream_error")
	combined := logs.String() + recorder.Body.String()
	for _, forbidden := range []string{fakeLocalToken, fakeUpstreamToken, sensitivePrompt, sensitiveResponse} {
		if strings.Contains(combined, forbidden) {
			t.Errorf("logs or local error leaked %q: %s", forbidden, combined)
		}
	}
	for _, required := range []string{"active_attempts", "queued_attempts", "admitted_requests", "effective_rpm"} {
		if !strings.Contains(logs.String(), required) {
			t.Errorf("structured log omitted aggregate field %q: %s", required, logs.String())
		}
	}
}
