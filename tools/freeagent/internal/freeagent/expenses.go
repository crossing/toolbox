package freeagent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
)

type Expense struct {
	URL                  string      `json:"url,omitempty"`
	User                 string      `json:"user,omitempty"`
	Category             string      `json:"category,omitempty"`
	DatedOn              string      `json:"dated_on,omitempty"`
	GrossValue           string      `json:"gross_value,omitempty"`
	Currency             string      `json:"currency,omitempty"`
	Description          string      `json:"description,omitempty"`
	SalesTaxRate         string      `json:"sales_tax_rate,omitempty"`
	ManualSalesTaxAmount string      `json:"manual_sales_tax_amount,omitempty"`
	ECStatus             string      `json:"ec_status,omitempty"`
	Attachment           *Attachment `json:"attachment,omitempty"`
}

type ExpensesResponse struct {
	Expenses []Expense `json:"expenses"`
}

type ExpenseRequest struct {
	Expense Expense `json:"expense"`
}

func (c *Client) ListExpenses(fromDate string) ([]Expense, error) {
	u, _ := url.Parse(c.BaseURL + "/expenses")
	q := u.Query()
	if fromDate != "" {
		q.Set("from_date", fromDate)
	}
	q.Set("per_page", "100")
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}

	var resp ExpensesResponse
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return resp.Expenses, nil
}

func (c *Client) CreateExpense(expense Expense) (*Expense, error) {
	data, err := json.Marshal(ExpenseRequest{Expense: expense})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, c.BaseURL+"/expenses", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	var resp ExpenseRequest
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return &resp.Expense, nil
}
