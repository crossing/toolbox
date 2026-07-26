package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
)

const testLocalKey = "sk-local-fake-test-key"

func testCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	c := &catalog.Catalog{Models: map[string]catalog.Model{
		"vendor/model": {Name: "Vendor Model", Owner: "vendor"},
		"alpha":        {Name: "Alpha"},
	}}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	return c
}

func request(t *testing.T, handler http.Handler, method, target, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestModelsRequireAuthentication(t *testing.T) {
	handler := New(testCatalog(t), testLocalKey, nil, nil)
	for _, token := range []string{"", "wrong"} {
		rec := request(t, handler, http.MethodGet, "/v1/models", token)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q status = %d, want %d", token, rec.Code, http.StatusUnauthorized)
		}
		if rec.Body.String() == "" || rec.Body.String() == testLocalKey {
			t.Fatalf("unsafe error body %q", rec.Body.String())
		}
	}
}

func TestListModelsUsesStandardShapeAndStableOrder(t *testing.T) {
	handler := New(testCatalog(t), testLocalKey, nil, nil)
	rec := request(t, handler, http.MethodGet, "/v1/models", testLocalKey)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
	}

	var got catalog.OpenAIList
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Object != "list" || len(got.Data) != 2 {
		t.Fatalf("response = %#v", got)
	}
	if got.Data[0].ID != "alpha" || got.Data[1].ID != "vendor/model" {
		t.Fatalf("model order = %q, %q", got.Data[0].ID, got.Data[1].ID)
	}
}

func TestRetrieveModelSupportsSlashInID(t *testing.T) {
	handler := New(testCatalog(t), testLocalKey, nil, nil)
	target := "/v1/models/" + url.PathEscape("vendor/model")
	rec := request(t, handler, http.MethodGet, target, testLocalKey)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
	}
	var got catalog.OpenAIModel
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != "vendor/model" {
		t.Fatalf("model ID = %q", got.ID)
	}
}

func TestMissingModelAndWrongMethodsAreStructured(t *testing.T) {
	handler := New(testCatalog(t), testLocalKey, nil, nil)
	tests := []struct {
		method string
		target string
		want   int
	}{
		{method: http.MethodGet, target: "/v1/models/missing", want: http.StatusNotFound},
		{method: http.MethodPost, target: "/v1/models", want: http.StatusMethodNotAllowed},
		{method: http.MethodPost, target: "/healthz", want: http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		rec := request(t, handler, tt.method, tt.target, testLocalKey)
		if rec.Code != tt.want {
			t.Fatalf("%s %s status = %d, want %d", tt.method, tt.target, rec.Code, tt.want)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/json" {
			t.Fatalf("Content-Type = %q", got)
		}
	}
}

func TestHealthIsSanitizedAndUnauthenticated(t *testing.T) {
	snapshot := &fixedSnapshotter{value: Snapshot{
		OK:             true,
		ConfiguredRPM:  32,
		EffectiveRPM:   16,
		MaxInflight:    3,
		Queued:         7,
		QueueLimit:     128,
		QueuedBytes:    99,
		MaxQueuedBytes: 1024,
	}}
	handler := New(testCatalog(t), testLocalKey, snapshot, nil)
	rec := request(t, handler, http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if contains(rec.Body.String(), testLocalKey) || contains(rec.Body.String(), "vendor/model") {
		t.Fatalf("health body leaked sensitive detail: %s", rec.Body.String())
	}
}

func TestInferenceRoutesDelegateAfterAuthentication(t *testing.T) {
	called := false
	inference := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusAccepted)
	})
	handler := New(testCatalog(t), testLocalKey, nil, inference)

	rec := request(t, handler, http.MethodPost, "/v1/chat/completions", testLocalKey)
	if rec.Code != http.StatusAccepted || !called {
		t.Fatalf("status = %d, called = %v", rec.Code, called)
	}
}

type fixedSnapshotter struct{ value Snapshot }

func (s *fixedSnapshotter) Snapshot() Snapshot { return s.value }

func contains(value, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
