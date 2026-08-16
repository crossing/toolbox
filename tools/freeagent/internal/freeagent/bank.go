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
	URL                  string      `json:"url,omitempty"`
	BankTransaction      string      `json:"bank_transaction,omitempty"`
	BankAccount          string      `json:"bank_account,omitempty"`
	DatedOn              string      `json:"dated_on,omitempty"`
	GrossValue           string      `json:"gross_value,omitempty"`
	Category             string      `json:"category,omitempty"`
	Description          string      `json:"description,omitempty"`
	PaidBill             string      `json:"paid_bill,omitempty"`
	TransferBankAccount  string      `json:"transfer_bank_account,omitempty"`
	SalesTaxRate         string      `json:"sales_tax_rate,omitempty"`
	ManualSalesTaxAmount string      `json:"manual_sales_tax_amount,omitempty"`
	ECStatus             string      `json:"ec_status,omitempty"`
	MarkedForReview      *bool       `json:"marked_for_review,omitempty"`
	Attachment           *Attachment `json:"attachment,omitempty"`
}

type BankTransactionsResponse struct {
	BankTransactions []BankTransaction `json:"bank_transactions"`
}

type BankTransactionExplanationRequest struct {
	BankTransactionExplanation BankTransactionExplanation `json:"bank_transaction_explanation"`
}

func (c *Client) ListBankTransactions(bankAccount, view, fromDate string) ([]BankTransaction, error) {
	u, _ := url.Parse(c.BaseURL + "/bank_transactions")
	q := u.Query()
	if bankAccount != "" {
		q.Set("bank_account", bankAccount)
	}
	if view != "" {
		q.Set("view", view)
	}
	if fromDate != "" {
		q.Set("from_date", fromDate)
	}
	q.Set("per_page", "100")
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

// Delete issues a DELETE to an arbitrary API URL.
func (c *Client) Delete(rawurl string) error {
	req, err := http.NewRequest(http.MethodDelete, rawurl, nil)
	if err != nil {
		return err
	}

	return c.Do(req, nil)
}

// GetJSON fetches an arbitrary API URL and returns the decoded JSON body.
// Used for detail views whose full response shape has no dedicated struct.
func (c *Client) GetJSON(rawurl string) (map[string]interface{}, error) {
	req, err := http.NewRequest(http.MethodGet, rawurl, nil)
	if err != nil {
		return nil, err
	}

	var resp map[string]interface{}
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return resp, nil
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
