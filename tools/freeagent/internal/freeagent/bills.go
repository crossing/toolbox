package freeagent

import (
	"bytes"
	"encoding/json"
	"net/http"
)

type Bill struct {
	URL         string     `json:"url,omitempty"`
	Contact     string     `json:"contact,omitempty"`
	Reference   string     `json:"reference,omitempty"`
	DatedOn     string     `json:"dated_on,omitempty"`
	DueOn       string     `json:"due_on,omitempty"`
	Status      string     `json:"status,omitempty"`
	TotalValue  string     `json:"total_value,omitempty"`
	PaidValue   string     `json:"paid_value,omitempty"`
	DueValue    string     `json:"due_value,omitempty"`
	BillItems   []BillItem `json:"bill_items,omitempty"`
	Attachment  *Attachment `json:"attachment,omitempty"`
}

type BillItem struct {
	URL         string `json:"url,omitempty"`
	Category    string `json:"category,omitempty"`
	TotalValue  string `json:"total_value,omitempty"`
	Description string `json:"description,omitempty"`
}

type BillsResponse struct {
	Bills []Bill `json:"bills"`
}

type BillRequest struct {
	Bill Bill `json:"bill"`
}

func (c *Client) ListBills() ([]Bill, error) {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/bills", nil)
	if err != nil {
		return nil, err
	}

	var resp BillsResponse
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return resp.Bills, nil
}

func (c *Client) CreateBill(bill Bill) (*Bill, error) {
	data, err := json.Marshal(BillRequest{Bill: bill})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, c.BaseURL+"/bills", bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	var resp BillRequest
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return &resp.Bill, nil
}

func (c *Client) UpdateBill(url string, bill Bill) (*Bill, error) {
	data, err := json.Marshal(BillRequest{Bill: bill})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(data))
	if err != nil {
		return nil, err
	}

	var resp BillRequest
	if err := c.Do(req, &resp); err != nil {
		return nil, err
	}

	return &resp.Bill, nil
}
