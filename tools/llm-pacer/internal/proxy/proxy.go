// Package proxy integrates admission, pacing, retries, and raw HTTP forwarding
// for authenticated inference routes.
package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/retry"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/scheduler"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/upstream"
)

const firstResponseChunkBytes = 32 * 1024

type Doer interface {
	Do(context.Context, *upstream.BufferedRequest) (*http.Response, error)
}

type Config struct {
	Catalog             *catalog.Catalog
	Scheduler           *scheduler.Scheduler
	Upstream            Doer
	RetryPolicy         *retry.Policy
	MaxRequestBodyBytes int64
	Logger              *slog.Logger
	Now                 func() time.Time
	Sleep               func(context.Context, time.Duration) error
}

type Handler struct {
	catalog             *catalog.Catalog
	scheduler           *scheduler.Scheduler
	upstream            Doer
	retryPolicy         *retry.Policy
	maxRequestBodyBytes int64
	logger              *slog.Logger
	now                 func() time.Time
	sleep               func(context.Context, time.Duration) error
}

func New(config Config) (*Handler, error) {
	if config.Catalog == nil || len(config.Catalog.Models) == 0 {
		return nil, errors.New("proxy model catalog is required")
	}
	if config.Scheduler == nil {
		return nil, errors.New("proxy scheduler is required")
	}
	if config.Upstream == nil {
		return nil, errors.New("proxy upstream client is required")
	}
	if config.RetryPolicy == nil {
		return nil, errors.New("proxy retry policy is required")
	}
	if config.MaxRequestBodyBytes <= 0 {
		return nil, errors.New("proxy maximum request body size must be positive")
	}
	if config.Logger == nil {
		config.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Sleep == nil {
		config.Sleep = sleepContext
	}
	return &Handler{
		catalog:             config.Catalog,
		scheduler:           config.Scheduler,
		upstream:            config.Upstream,
		retryPolicy:         config.RetryPolicy,
		maxRequestBodyBytes: config.MaxRequestBodyBytes,
		logger:              config.Logger,
		now:                 config.Now,
		sleep:               config.Sleep,
	}, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	started := h.now()
	requestID := safeRequestID(request.Header.Get("X-Request-Id"))
	w.Header().Set("X-Request-Id", requestID)

	body, localErr := readBody(request, h.maxRequestBodyBytes)
	if localErr != nil {
		h.writeLocalError(w, request, requestID, "", 0, started, localErr)
		return
	}
	model, localErr := h.validateModel(request, body)
	if localErr != nil {
		h.writeLocalError(w, request, requestID, "", 0, started, localErr)
		return
	}

	forwardHeaders := request.Header.Clone()
	forwardHeaders.Set("X-Request-Id", requestID)
	buffered, err := upstream.NewBufferedRequest(
		request.Method,
		request.URL.EscapedPath(),
		request.URL.RawQuery,
		forwardHeaders,
		body,
	)
	if err != nil {
		h.writeLocalError(w, request, requestID, model, 0, started, newLocalError(
			http.StatusBadRequest,
			"proxy_invalid_request",
			"request cannot be forwarded",
		))
		return
	}

	ticket, err := h.scheduler.Admit(request.Context(), int64(len(body)))
	if err != nil {
		if errors.Is(err, scheduler.ErrQueueFull) {
			delay := h.queueRetryDelay()
			setRetryHeaders(w.Header(), delay)
			h.writeLocalError(w, request, requestID, model, 0, started, newLocalError(
				http.StatusTooManyRequests,
				"proxy_queue_full",
				"proxy admission queue is full",
			))
			return
		}
		if request.Context().Err() != nil {
			return
		}
		h.writeLocalError(w, request, requestID, model, 0, started, newLocalError(
			http.StatusServiceUnavailable,
			"proxy_unavailable",
			"proxy scheduler is unavailable",
		))
		return
	}
	defer func() { _ = ticket.Close() }()

	retriesUsed := 0
	for {
		attempt, attemptErr := ticket.RequestAttempt(request.Context())
		if attemptErr != nil {
			if request.Context().Err() != nil {
				return
			}
			h.writeLocalError(w, request, requestID, model, retriesUsed, started, newLocalError(
				http.StatusServiceUnavailable,
				"proxy_unavailable",
				"proxy scheduler is unavailable",
			))
			return
		}

		response, upstreamErr := h.upstream.Do(request.Context(), buffered)
		if upstreamErr != nil {
			_ = attempt.Finish(scheduler.Outcome{})
			if request.Context().Err() != nil {
				return
			}
			decision := h.retryPolicy.Decide(retriesUsed, 0, nil, upstreamErr, h.now())
			if decision.Retry {
				h.logRetry(request, requestID, model, retriesUsed+1, 0, decision.Delay)
				retriesUsed++
				if err := h.sleep(request.Context(), decision.Delay); err != nil {
					return
				}
				continue
			}
			h.writeLocalError(w, request, requestID, model, retriesUsed+1, started, newLocalError(
				http.StatusBadGateway,
				"proxy_upstream_error",
				"upstream request failed",
			))
			return
		}

		now := h.now()
		retryHint := retry.RetryAfter(response.Header, now)
		decision := h.retryPolicy.Decide(retriesUsed, response.StatusCode, response.Header, nil, now)
		if decision.Retry {
			_ = response.Body.Close()
			_ = attempt.Finish(scheduler.Outcome{
				StatusCode: response.StatusCode,
				RetryAfter: retryHint,
			})
			h.logRetry(request, requestID, model, retriesUsed+1, response.StatusCode, decision.Delay)
			retriesUsed++
			if err := h.sleep(request.Context(), decision.Delay); err != nil {
				return
			}
			continue
		}

		committed, bytesWritten, copyErr := copyResponse(w, request, response)
		_ = response.Body.Close()
		outcome := scheduler.Outcome{StatusCode: response.StatusCode, RetryAfter: retryHint}
		if copyErr != nil && !committed {
			outcome.StatusCode = 0
		}
		_ = attempt.Finish(outcome)

		if copyErr != nil && !committed && request.Context().Err() == nil && response.StatusCode >= 200 && response.StatusCode <= 299 {
			decision = h.retryPolicy.Decide(retriesUsed, 0, nil, copyErr, h.now())
			if decision.Retry {
				h.logRetry(request, requestID, model, retriesUsed+1, 0, decision.Delay)
				retriesUsed++
				if err := h.sleep(request.Context(), decision.Delay); err != nil {
					return
				}
				continue
			}
			h.writeLocalError(w, request, requestID, model, retriesUsed+1, started, newLocalError(
				http.StatusBadGateway,
				"proxy_upstream_error",
				"upstream response failed",
			))
			return
		}

		h.logger.Info("llm request complete",
			"request_id", requestID,
			"route", request.URL.Path,
			"model", model,
			"attempts", retriesUsed+1,
			"upstream_status", response.StatusCode,
			"response_bytes", bytesWritten,
			"duration_ms", h.now().Sub(started).Milliseconds(),
			"outcome", outcomeName(copyErr, request.Context().Err()),
		)
		return
	}
}

func readBody(request *http.Request, maximum int64) ([]byte, *localError) {
	if request.Body == nil {
		return nil, nil
	}
	defer request.Body.Close()
	body, err := io.ReadAll(io.LimitReader(request.Body, maximum+1))
	if err != nil {
		return nil, newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body could not be read")
	}
	if int64(len(body)) > maximum {
		return nil, newLocalError(http.StatusRequestEntityTooLarge, "proxy_request_too_large", "request body exceeds configured limit")
	}
	return body, nil
}

func (h *Handler) validateModel(request *http.Request, body []byte) (string, *localError) {
	required := routeRequiresModel(request.Method, request.URL.Path)
	if len(body) == 0 {
		if required {
			return "", newLocalError(http.StatusBadRequest, "proxy_model_required", "request must contain an allowed model")
		}
		return "", nil
	}

	contentEncoding := strings.TrimSpace(request.Header.Get("Content-Encoding"))
	if required && contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "encoded inference request bodies are not supported")
	}
	jsonBody := required || hasJSONMediaType(request.Header.Get("Content-Type")) || firstNonSpace(body) == '{'
	if !jsonBody {
		return "", nil
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body, &envelope); err != nil || envelope == nil {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
	}
	rawModel, present := envelope["model"]
	if !present {
		if required {
			return "", newLocalError(http.StatusBadRequest, "proxy_model_required", "request must contain an allowed model")
		}
		return "", nil
	}
	var model string
	if err := json.Unmarshal(rawModel, &model); err != nil || strings.TrimSpace(model) == "" || model != strings.TrimSpace(model) {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_model", "model must be a non-empty string")
	}
	if !h.catalog.Allows(model) {
		return "", newLocalError(http.StatusBadRequest, "proxy_model_not_allowed", "model is not allowed by this provider")
	}
	return model, nil
}

func routeRequiresModel(method, path string) bool {
	if method != http.MethodPost {
		return false
	}
	switch path {
	case "/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/responses":
		return true
	default:
		return false
	}
}

func hasJSONMediaType(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

func firstNonSpace(body []byte) byte {
	for _, value := range body {
		switch value {
		case ' ', '\t', '\r', '\n':
			continue
		default:
			return value
		}
	}
	return 0
}

func copyResponse(w http.ResponseWriter, request *http.Request, response *http.Response) (committed bool, written int64, err error) {
	buffer := make([]byte, firstResponseChunkBytes)
	count, readErr := response.Body.Read(buffer)
	if count == 0 && readErr != nil && !errors.Is(readErr, io.EOF) {
		return false, 0, readErr
	}

	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	committed = true
	streaming := strings.EqualFold(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]), "text/event-stream")
	if count > 0 {
		n, writeErr := w.Write(buffer[:count])
		written += int64(n)
		if writeErr != nil {
			return true, written, writeErr
		}
		if streaming {
			flush(w)
		}
	}
	if readErr != nil {
		if errors.Is(readErr, io.EOF) {
			return true, written, nil
		}
		return true, written, readErr
	}

	for {
		count, readErr = response.Body.Read(buffer)
		if count > 0 {
			n, writeErr := w.Write(buffer[:count])
			written += int64(n)
			if writeErr != nil {
				return true, written, writeErr
			}
			if streaming {
				flush(w)
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return true, written, nil
			}
			return true, written, readErr
		}
		if request.Context().Err() != nil {
			return true, written, request.Context().Err()
		}
	}
}

func copyResponseHeaders(destination, source http.Header) {
	clean := source.Clone()
	removeHopByHop(clean)
	for name, values := range clean {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func removeHopByHop(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, nominated := range strings.Split(value, ",") {
			if name := strings.TrimSpace(nominated); name != "" {
				header.Del(name)
			}
		}
	}
	for _, name := range []string{
		"Authorization", "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
		"Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		header.Del(name)
	}
}

func flush(w http.ResponseWriter) {
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (h *Handler) queueRetryDelay() time.Duration {
	snapshot := h.scheduler.Snapshot()
	if snapshot.EffectiveRPM <= 0 || math.IsNaN(snapshot.EffectiveRPM) || math.IsInf(snapshot.EffectiveRPM, 0) {
		return time.Second
	}
	delay := time.Duration(float64(time.Minute) / snapshot.EffectiveRPM)
	if delay < time.Millisecond {
		return time.Millisecond
	}
	return delay
}

func setRetryHeaders(header http.Header, delay time.Duration) {
	milliseconds := int64(math.Ceil(float64(delay) / float64(time.Millisecond)))
	if milliseconds < 1 {
		milliseconds = 1
	}
	seconds := (milliseconds + 999) / 1000
	header.Set("Retry-After", fmt.Sprintf("%d", seconds))
	header.Set("retry-after-ms", fmt.Sprintf("%d", milliseconds))
}

func safeRequestID(candidate string) string {
	if candidate != "" && len(candidate) <= 128 {
		valid := true
		for _, value := range candidate {
			if value < 0x21 || value > 0x7e {
				valid = false
				break
			}
		}
		if valid {
			return candidate
		}
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return fmt.Sprintf("local-%d", time.Now().UnixNano())
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (h *Handler) logRetry(request *http.Request, requestID, model string, attempt, status int, delay time.Duration) {
	h.logger.Warn("llm request retry scheduled",
		"request_id", requestID,
		"route", request.URL.Path,
		"model", model,
		"attempt", attempt,
		"upstream_status", status,
		"retry_delay_ms", delay.Milliseconds(),
		"effective_rpm", h.scheduler.Snapshot().EffectiveRPM,
	)
}

func (h *Handler) writeLocalError(w http.ResponseWriter, request *http.Request, requestID, model string, attempts int, started time.Time, localErr *localError) {
	writeError(w, localErr.status, localErr.code, localErr.message)
	h.logger.Warn("llm request rejected",
		"request_id", requestID,
		"route", request.URL.Path,
		"model", model,
		"attempts", attempts,
		"status", localErr.status,
		"error_code", localErr.code,
		"duration_ms", h.now().Sub(started).Milliseconds(),
	)
}

type localError struct {
	status  int
	code    string
	message string
}

func newLocalError(status int, code, message string) *localError {
	return &localError{status: status, code: code, message: message}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"message": message,
			"type":    code,
			"code":    code,
		},
	})
}

func outcomeName(copyErr, contextErr error) string {
	switch {
	case contextErr != nil:
		return "client_canceled"
	case copyErr != nil:
		return "stream_error"
	default:
		return "complete"
	}
}
