package freeagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_ListBills(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/bills" {
			t.Errorf("expected path /v2/bills, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"bills": [{"reference": "BILL-001"}]}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL + "/v2"

	bills, err := client.ListBills()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(bills) != 1 {
		t.Errorf("expected 1 bill, got %d", len(bills))
	}
	if bills[0].Reference != "BILL-001" {
		t.Errorf("expected reference BILL-001, got %s", bills[0].Reference)
	}
}

func TestClient_CreateBill(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected method POST, got %s", r.Method)
		}
		var req BillRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}
		if req.Bill.Reference != "NEW-BILL" {
			t.Errorf("expected reference NEW-BILL, got %s", req.Bill.Reference)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"bill": {"url": "https://api.freeagent.com/v2/bills/1", "reference": "NEW-BILL"}}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL + "/v2"

	bill := Bill{Reference: "NEW-BILL"}
	newBill, err := client.CreateBill(bill)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if newBill.URL == "" {
		t.Error("expected bill URL to be set")
	}
}
