package freeagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
)

type BankTransaction struct {
	URL         string `json:"url,omitempty"`
	BankAccount string `json:"bank_account"`
	DatedOn     string `json:"dated_on"`
	Description string `json:"description"`
	Amount      string `json:"amount"`
	Unexplained string `json:"unexplained_amount,omitempty"`
}

type BankTransactionExplanation struct {
	URL             string `json:"url,omitempty"`
	BankTransaction string `json:"bank_transaction,omitempty"`
	BankAccount     string `json:"bank_account,omitempty"`
	DatedOn         string `json:"dated_on,omitempty"`
	GrossValue      string `json:"gross_value,omitempty"`
	Category        string `json:"category,omitempty"`
	Description     string `json:"description,omitempty"`
	Attachment      *Attachment `json:"attachment,omitempty"`
}

type BankTransactionsResponse struct {
	BankTransactions []BankTransaction `json:"bank_transactions"`
}

type BankTransactionExplanationRequest struct {
	BankTransactionExplanation BankTransactionExplanation `json:"bank_transaction_explanation"`
}

func (c *Client) ListBankTransactions(bankAccount string) ([]BankTransaction, error) {
	u, _ := url.Parse(c.BaseURL + "/bank_transactions")
	q := u.Query()
	if bankAccount != "" {
		q.Set("bank_account", bankAccount)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}

	var resp BankTransactionsResponse
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return resp.BankTransactions, nil
}

func (c *Client) CreateBankTransactionExplanation(explanation BankTransactionExplanation) (*BankTransactionExplanation, error) {
	data, err := json.Marshal(BankTransactionExplanationRequest{BankTransactionExplanation: explanation})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, c.BaseURL+"/bank_transaction_explanations", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	var resp BankTransactionExplanationRequest
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return &resp.BankTransactionExplanation, nil
}

func (c *Client) UpdateBankTransactionExplanation(url string, explanation BankTransactionExplanation) (*BankTransactionExplanation, error) {
	data, err := json.Marshal(BankTransactionExplanationRequest{BankTransactionExplanation: explanation})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	var resp BankTransactionExplanationRequest
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return &resp.BankTransactionExplanation, nil
}
