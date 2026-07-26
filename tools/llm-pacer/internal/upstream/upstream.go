// Package upstream provides the single-attempt HTTP transport used to call an
// OpenAI-compatible upstream.
package upstream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/retry"
)

// Config controls the upstream HTTP transport. All timeout values and
// MaxInflight must be positive.
type Config struct {
	BaseURL               string
	BearerToken           string
	ConnectTimeout        time.Duration
	ResponseHeaderTimeout time.Duration
	StreamIdleTimeout     time.Duration
	MaxInflight           int
}

// Client sends exactly one HTTP transaction for each call to Do. Retry and
// response-body ownership remain with the caller.
type Client struct {
	baseURL           url.URL
	authorization     string
	streamIdleTimeout time.Duration
	transport         *http.Transport
}

// BufferedRequest is an immutable, replayable request description. Its body
// and headers are copied by NewBufferedRequest, and Do creates a fresh
// *http.Request and one-shot body reader for every explicit attempt.
type BufferedRequest struct {
	method      string
	escapedPath string
	rawQuery    string
	headers     http.Header
	body        []byte
}

// NewClient validates config and constructs a bounded HTTP transport.
func NewClient(config Config) (*Client, error) {
	baseURL, err := validateBaseURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if config.BearerToken == "" || strings.TrimSpace(config.BearerToken) != config.BearerToken || strings.ContainsAny(config.BearerToken, "\r\n") {
		return nil, errors.New("upstream bearer token must be a non-empty HTTP bearer token")
	}
	if config.ConnectTimeout <= 0 {
		return nil, errors.New("upstream connect timeout must be positive")
	}
	if config.ResponseHeaderTimeout <= 0 {
		return nil, errors.New("upstream response header timeout must be positive")
	}
	if config.StreamIdleTimeout <= 0 {
		return nil, errors.New("upstream stream idle timeout must be positive")
	}
	if config.MaxInflight <= 0 {
		return nil, errors.New("upstream max inflight must be positive")
	}

	dialer := &net.Dialer{
		Timeout:   config.ConnectTimeout,
		KeepAlive: 30 * time.Second,
	}
	transport := &http.Transport{
		// Do not send the upstream bearer token to an ambient HTTP_PROXY. A
		// future explicit proxy option can add that trust boundary deliberately.
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			connection, err := dialer.DialContext(ctx, network, address)
			if err != nil {
				return nil, markSafePreRequestDialError(err)
			}
			return connection, nil
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          config.MaxInflight,
		MaxIdleConnsPerHost:   config.MaxInflight,
		MaxConnsPerHost:       config.MaxInflight,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   config.ConnectTimeout,
		ResponseHeaderTimeout: config.ResponseHeaderTimeout,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
	}

	return &Client{
		baseURL:           *baseURL,
		authorization:     "Bearer " + config.BearerToken,
		streamIdleTimeout: config.StreamIdleTimeout,
		transport:         transport,
	}, nil
}

func markSafePreRequestDialError(err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}

	// A permanent lookup failure is not made retryable merely because it also
	// satisfies net.Error. Only DNS failures explicitly classified as timeout
	// or temporary are safe candidates.
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		if dnsError.IsTimeout || dnsError.IsTemporary {
			return retry.MarkSafeTransportError(err)
		}
		return err
	}

	for _, transient := range []error{
		syscall.ECONNREFUSED,
		syscall.ECONNRESET,
		syscall.EHOSTUNREACH,
		syscall.ENETUNREACH,
		syscall.ETIMEDOUT,
	} {
		if errors.Is(err, transient) {
			return retry.MarkSafeTransportError(err)
		}
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return retry.MarkSafeTransportError(err)
	}
	return err
}

func validateBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("invalid upstream base URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, errors.New("upstream base URL must use http or https")
	}
	if parsed.Host == "" || parsed.Opaque != "" {
		return nil, errors.New("upstream base URL must be absolute")
	}
	if parsed.User != nil {
		return nil, errors.New("upstream base URL must not contain user information")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return nil, errors.New("upstream base URL must not contain a query")
	}
	if parsed.Fragment != "" {
		return nil, errors.New("upstream base URL must not contain a fragment")
	}
	parsed.Scheme = scheme
	return parsed, nil
}

// NewBufferedRequest validates and snapshots an inbound request. escapedPath
// must be an absolute escaped path and rawQuery must not include a leading '?'.
func NewBufferedRequest(method, escapedPath, rawQuery string, headers http.Header, body []byte) (*BufferedRequest, error) {
	if _, err := http.NewRequest(method, "http://request.invalid/", nil); err != nil {
		return nil, fmt.Errorf("invalid upstream method: %w", err)
	}
	if escapedPath == "" || escapedPath[0] != '/' {
		return nil, errors.New("upstream escaped path must begin with a slash")
	}
	if strings.HasPrefix(rawQuery, "?") {
		return nil, errors.New("upstream raw query must not begin with a question mark")
	}

	requestURI := escapedPath
	if rawQuery != "" {
		requestURI += "?" + rawQuery
	}
	parsed, err := url.ParseRequestURI(requestURI)
	if err != nil || parsed.EscapedPath() != escapedPath || parsed.RawQuery != rawQuery {
		return nil, errors.New("invalid upstream escaped path or raw query")
	}

	return &BufferedRequest{
		method:      method,
		escapedPath: escapedPath,
		rawQuery:    rawQuery,
		headers:     cloneHeader(headers),
		body:        bytes.Clone(body),
	}, nil
}

// Do performs one upstream transaction. It does not follow redirects, retry
// status codes, or buffer the response body.
func (client *Client) Do(ctx context.Context, buffered *BufferedRequest) (*http.Response, error) {
	if client == nil || client.transport == nil {
		return nil, errors.New("upstream client is nil")
	}
	if ctx == nil {
		return nil, errors.New("upstream context is nil")
	}
	if buffered == nil {
		return nil, errors.New("upstream buffered request is nil")
	}

	target, err := client.targetURL(buffered.escapedPath, buffered.rawQuery)
	if err != nil {
		return nil, err
	}

	// Always use an unrewindable, non-nil body, including for an empty body.
	// net/http therefore cannot transparently replay an idempotent request on a
	// stale pooled connection. Explicit llm-pacer retries call Do again and get a
	// fresh reader over the immutable bytes.
	body := &oneShotReader{reader: bytes.NewReader(buffered.body)}
	request, err := http.NewRequestWithContext(ctx, buffered.method, target.String(), body)
	if err != nil {
		return nil, fmt.Errorf("create upstream request: %w", err)
	}
	request.ContentLength = int64(len(buffered.body))
	request.GetBody = nil
	request.Header = prepareHeaders(buffered.headers, client.authorization)

	response, err := client.transport.RoundTrip(request)
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, fmt.Errorf("perform upstream request: %w", err)
	}
	response.Body = newIdleReadCloser(ctx, response.Body, client.streamIdleTimeout)
	return response, nil
}

func (client *Client) targetURL(escapedPath, rawQuery string) (*url.URL, error) {
	target := client.baseURL
	joinedEscapedPath := joinEscapedPath(target.EscapedPath(), escapedPath)
	joinedPath, err := url.PathUnescape(joinedEscapedPath)
	if err != nil {
		return nil, errors.New("invalid joined upstream path")
	}
	target.Path = joinedPath
	target.RawPath = joinedEscapedPath
	target.RawQuery = rawQuery
	target.ForceQuery = false
	return &target, nil
}

func joinEscapedPath(basePath, requestPath string) string {
	if basePath == "" || basePath == "/" {
		return requestPath
	}
	return strings.TrimSuffix(basePath, "/") + requestPath
}

func prepareHeaders(source http.Header, authorization string) http.Header {
	headers := cloneHeader(source)
	for _, value := range headers.Values("Connection") {
		for _, nominated := range strings.Split(value, ",") {
			if name := strings.TrimSpace(nominated); name != "" {
				headers.Del(name)
			}
		}
	}
	for _, name := range []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Proxy-Connection",
		"Te",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
		"Content-Length",
		"Host",
	} {
		headers.Del(name)
	}
	// Incoming local credentials are never forwarded. Set replaces every value.
	headers.Del("Authorization")
	headers.Set("Authorization", authorization)
	return headers
}

func cloneHeader(source http.Header) http.Header {
	if source == nil {
		return make(http.Header)
	}
	return source.Clone()
}

// CloseIdleConnections releases pooled upstream connections. Active responses
// remain owned by their callers.
func (client *Client) CloseIdleConnections() {
	if client != nil && client.transport != nil {
		client.transport.CloseIdleConnections()
	}
}

type oneShotReader struct {
	reader *bytes.Reader
}

func (reader *oneShotReader) Read(p []byte) (int, error) {
	return reader.reader.Read(p)
}
