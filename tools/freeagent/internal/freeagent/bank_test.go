package freeagent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_ListBankTransactions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/bank_transactions" {
			t.Errorf("expected path /v2/bank_transactions, got %s", r.URL.Path)
		}
		if r.URL.Query().Get("bank_account") != "123" {
			t.Errorf("expected bank_account 123, got %s", r.URL.Query().Get("bank_account"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"bank_transactions": [{"description": "Coffee"}]}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL + "/v2"

	txs, err := client.ListBankTransactions("123", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(txs) != 1 {
		t.Errorf("expected 1 transaction, got %d", len(txs))
	}
}

func TestClient_CreateExplanation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req BankTransactionExplanationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("failed to decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"bank_transaction_explanation": {"url": "https://api.freeagent.com/v2/bank_transaction_explanations/1"}}`))
	}))
	defer server.Close()

	client := NewClient("test-token")
	client.BaseURL = server.URL + "/v2"

	explanation := BankTransactionExplanation{DatedOn: "2026-05-01", GrossValue: "-5.00", Category: "https://api.freeagent.com/v2/categories/285"}
	newExp, err := client.CreateBankTransactionExplanation(explanation)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if newExp.URL == "" {
		t.Error("expected explanation URL to be set")
	}
}
