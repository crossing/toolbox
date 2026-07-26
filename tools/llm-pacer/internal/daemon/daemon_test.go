package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/config"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/httpapi"
)

const (
	fakeUpstreamKey = "fixture-upstream-key"
	fakeLocalKey    = "fixture-local-key"
	fakeModelID     = "fixture-model"
)

func daemonConfig(upstreamURL string) *config.Config {
	cfg := config.Defaults()
	cfg.UpstreamBaseURL = upstreamURL
	cfg.RPM = 120
	cfg.MinAdaptiveRPM = 10
	cfg.MaxInflight = 2
	cfg.QueueLimit = 7
	cfg.MaxQueuedBodyBytes = 4096
	cfg.MaxRequestBodyBytes = 2048
	cfg.MaxRetries = 1
	cfg.MaxBackoff = config.NewDuration(time.Second)
	cfg.UpstreamRequestTimeout = config.NewDuration(2 * time.Second)
	cfg.StreamIdleTimeout = config.NewDuration(2 * time.Second)
	cfg.ConnectTimeout = config.NewDuration(time.Second)
	cfg.Models = map[string]catalog.Model{
		fakeModelID: {
			Name:    "Fixture Model",
			Owner:   "fixture-owner",
			Created: 123,
			Limits:  catalog.Limits{Context: 4096, Output: 512},
			Modalities: catalog.Modalities{
				Input:  []string{"text"},
				Output: []string{"text"},
			},
		},
	}
	return &cfg
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func authorizedRequest(t *testing.T, handler http.Handler, method, target string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+fakeLocalKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestHandlerAuthenticationHealthModelsAndForwarding(t *testing.T) {
	type observedRequest struct {
		method        string
		path          string
		authorization []string
		body          []byte
	}
	observed := make(chan observedRequest, 1)
	var upstreamCalls atomic.Int64
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		upstreamCalls.Add(1)
		body, _ := io.ReadAll(request.Body)
		observed <- observedRequest{
			method:        request.Method,
			path:          request.URL.EscapedPath(),
			authorization: append([]string(nil), request.Header.Values("Authorization")...),
			body:          body,
		}
		w.Header().Set("X-Upstream-Fixture", "present")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"id":"fixture-response","choices":[]}`)
	}))
	defer upstreamServer.Close()

	cfg := daemonConfig(upstreamServer.URL + "/gateway")
	daemon, err := New(cfg, fakeUpstreamKey, fakeLocalKey, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()
	handler := daemon.Handler()

	healthRequest := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	healthResponse := httptest.NewRecorder()
	handler.ServeHTTP(healthResponse, healthRequest)
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", healthResponse.Code)
	}
	var health httpapi.Snapshot
	if err := json.Unmarshal(healthResponse.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if !health.OK || health.ConfiguredRPM != cfg.RPM || health.EffectiveRPM != cfg.RPM || health.MaxInflight != cfg.MaxInflight || health.QueueLimit != cfg.QueueLimit || health.MaxQueuedBytes != cfg.MaxQueuedBodyBytes {
		t.Fatalf("health limits = %+v", health)
	}
	if health.Active != 0 || health.Queued != 0 || health.Admitted != 0 || health.QueuedBytes != 0 {
		t.Fatalf("idle health counters = %+v", health)
	}

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized model discovery status = %d, want 401", unauthorized.Code)
	}
	wrongKeyRequest := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"fixture-model"}`))
	wrongKeyRequest.Header.Set("Authorization", "Bearer wrong-fixture-key")
	wrongKeyResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongKeyResponse, wrongKeyRequest)
	if wrongKeyResponse.Code != http.StatusUnauthorized || upstreamCalls.Load() != 0 {
		t.Fatalf("wrong-key request status=%d upstream_calls=%d", wrongKeyResponse.Code, upstreamCalls.Load())
	}

	models := authorizedRequest(t, handler, http.MethodGet, "/v1/models", nil)
	if models.Code != http.StatusOK {
		t.Fatalf("models status = %d, want 200", models.Code)
	}
	var modelList catalog.OpenAIList
	if err := json.Unmarshal(models.Body.Bytes(), &modelList); err != nil {
		t.Fatal(err)
	}
	if modelList.Object != "list" || len(modelList.Data) != 1 || modelList.Data[0].ID != fakeModelID || modelList.Data[0].OwnedBy != "fixture-owner" {
		t.Fatalf("model list = %+v", modelList)
	}
	model := authorizedRequest(t, handler, http.MethodGet, "/v1/models/"+fakeModelID, nil)
	if model.Code != http.StatusOK {
		t.Fatalf("model detail status = %d, want 200", model.Code)
	}

	requestBody := []byte(`{"model":"fixture-model","messages":[{"role":"user","content":"fixture prompt"}]}`)
	chat := authorizedRequest(t, handler, http.MethodPost, "/v1/chat/completions?fixture=1", requestBody)
	if chat.Code != http.StatusOK {
		t.Fatalf("chat status = %d body=%s", chat.Code, chat.Body.String())
	}
	if chat.Header().Get("X-Upstream-Fixture") != "present" {
		t.Fatal("upstream response header was not forwarded")
	}
	if !bytes.Contains(chat.Body.Bytes(), []byte(`"id":"fixture-response"`)) {
		t.Fatalf("chat response body = %s", chat.Body.String())
	}
	select {
	case got := <-observed:
		if got.method != http.MethodPost || got.path != "/gateway/v1/chat/completions" || !bytes.Equal(got.body, requestBody) {
			t.Fatalf("forwarded request method=%q path=%q body_matches=%v", got.method, got.path, bytes.Equal(got.body, requestBody))
		}
		if len(got.authorization) != 1 || got.authorization[0] != "Bearer "+fakeUpstreamKey {
			t.Fatalf("upstream authorization values = %d, replacement missing", len(got.authorization))
		}
	case <-time.After(time.Second):
		t.Fatal("upstream did not observe chat request")
	}
	if upstreamCalls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want 1", upstreamCalls.Load())
	}
}

func TestServeStopsGracefullyWhenContextIsCanceled(t *testing.T) {
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstreamServer.Close()

	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot reserve an ephemeral loopback port: %v", err)
	}
	address := reservation.Addr().String()
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}

	cfg := daemonConfig(upstreamServer.URL)
	cfg.ListenAddress = address
	daemon, err := New(cfg, fakeUpstreamKey, fakeLocalKey, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()

	ctx, cancel := context.WithCancel(context.Background())
	serveResult := make(chan error, 1)
	go func() { serveResult <- daemon.Serve(ctx) }()

	client := &http.Client{Timeout: 100 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	for {
		response, requestErr := client.Get("http://" + address + "/healthz")
		if requestErr == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("daemon did not begin serving on the reserved loopback port")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-serveResult:
		if err != nil {
			t.Fatalf("Serve() after cancellation = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve() did not complete graceful shutdown")
	}

	_, err = client.Get("http://" + address + "/healthz")
	if err == nil {
		t.Fatal("daemon still accepted connections after graceful shutdown")
	}
}
