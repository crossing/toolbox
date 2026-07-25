package freeagent

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const BaseURL = "https://api.freeagent.com/v2"

// Client is a FreeAgent API client
type Client struct {
	BaseURL     string
	AccessToken string
	HTTPClient  *http.Client
}

// NewClient creates a new FreeAgent API client
func NewClient(accessToken string) *Client {
	return &Client{
		BaseURL:     BaseURL,
		AccessToken: accessToken,
		HTTPClient: &http.Client{
			Timeout: time.Second * 30,
		},
	}
}

// APIError represents an error returned by the FreeAgent API
type APIError struct {
	StatusCode int
	Message    string
	Errors     map[string]interface{} `json:"errors,omitempty"`
}

func (e *APIError) Error() string {
	if len(e.Errors) > 0 {
		return fmt.Sprintf("API error (status %d): %s - %v", e.StatusCode, e.Message, e.Errors)
	}
	return fmt.Sprintf("API error (status %d): %s", e.StatusCode, e.Message)
}

// Do performs an HTTP request to the FreeAgent API
func (c *Client) Do(req *http.Request, v interface{}) error {
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "freeagent")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return c.handleError(resp)
	}

	if v != nil {
		if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}
	}

	return nil
}

func (c *Client) handleError(resp *http.Response) error {
	apiErr := &APIError{
		StatusCode: resp.StatusCode,
		Message:    resp.Status,
	}

	body, err := io.ReadAll(resp.Body)
	if err == nil && len(body) > 0 {
		_ = json.Unmarshal(body, apiErr)
	}

	return apiErr
}
