package freeagent

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_Do(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check headers
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("expected Authorization header Bearer test-token, got %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("expected Accept header application/json, got %s", r.Header.Get("Accept"))
		}

		// Mock response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"message": "success"}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL

	req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
	var resp struct {
		Message string `json:"message"`
	}

	err := client.Do(req, &resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if resp.Message != "success" {
		t.Errorf("expected message success, got %s", resp.Message)
	}
}

func TestClient_Do_Error(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"errors": {"field": "invalid"}}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL

	req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
	err := client.Do(req, nil)

	if err == nil {
		t.Fatal("expected error, got nil")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}

	if apiErr.StatusCode != http.StatusBadRequest {
		t.Errorf("expected status code 400, got %d", apiErr.StatusCode)
	}

	if val, ok := apiErr.Errors["field"]; !ok || val != "invalid" {
		t.Errorf("expected error for 'field' to be 'invalid', got %v", apiErr.Errors["field"])
	}
}
