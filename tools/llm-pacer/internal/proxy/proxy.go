// Package proxy integrates admission, pacing, retries, and raw HTTP forwarding
// for authenticated inference routes.
package proxy

import (
	"bytes"
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
	"mime/multipart"
	"net/http"
	"net/url"
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

	if localErr := validateForwardRoute(request); localErr != nil {
		if localErr.status == http.StatusMethodNotAllowed {
			w.Header().Set("Allow", http.MethodPost)
		}
		h.writeLocalError(w, request, requestID, "", 0, started, localErr)
		return
	}
	reservedBodyBytes, localErr := bodyReservation(request, h.maxRequestBodyBytes)
	if localErr != nil {
		h.writeLocalError(w, request, requestID, "", 0, started, localErr)
		return
	}

	// Reserve both admission count and worst-case retained body capacity before
	// reading from the client. Unknown-length/chunked bodies reserve the full
	// per-request limit, so slow uploads cannot sit outside the queue bounds.
	ticket, err := h.scheduler.Admit(request.Context(), reservedBodyBytes)
	if err != nil {
		if errors.Is(err, scheduler.ErrQueueFull) {
			delay := h.queueRetryDelay()
			setRetryHeaders(w.Header(), delay)
			h.writeLocalError(w, request, requestID, "", 0, started, newLocalError(
				http.StatusTooManyRequests,
				"proxy_queue_full",
				"proxy admission queue is full",
			))
			return
		}
		if request.Context().Err() != nil {
			return
		}
		h.writeLocalError(w, request, requestID, "", 0, started, newLocalError(
			http.StatusServiceUnavailable,
			"proxy_unavailable",
			"proxy scheduler is unavailable",
		))
		return
	}
	defer func() { _ = ticket.Close() }()

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
		retryHint := h.retryPolicy.RetryAfter(response.Header, now)
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
		// A truncated 2xx response is not a successful call, even when some
		// bytes were already committed and therefore cannot be retried. Reset
		// adaptive recovery without discarding meaningful 429/5xx outcomes.
		if copyErr != nil && response.StatusCode >= 200 && response.StatusCode <= 299 {
			outcome.StatusCode = 0
		}
		_ = attempt.Finish(outcome)

		if copyErr != nil && !committed && request.Context().Err() == nil {
			// The upstream has already processed this POST. A response-body read
			// failure does not prove that replaying it is safe, even when the
			// status was successful, so fail locally instead of duplicating work.
			h.writeLocalError(w, request, requestID, model, retriesUsed+1, started, newLocalError(
				http.StatusBadGateway,
				"proxy_upstream_error",
				"upstream response failed",
			))
			return
		}

		snapshot := h.scheduler.Snapshot()
		h.logger.Info("llm request complete",
			"request_id", requestID,
			"route", request.URL.Path,
			"model", model,
			"attempts", retriesUsed+1,
			"upstream_status", response.StatusCode,
			"response_bytes", bytesWritten,
			"active_attempts", snapshot.ActiveAttempts,
			"queued_attempts", snapshot.QueuedAttempts,
			"admitted_requests", snapshot.AdmittedRequests,
			"effective_rpm", snapshot.EffectiveRPM,
			"duration_ms", h.now().Sub(started).Milliseconds(),
			"outcome", outcomeName(copyErr, request.Context().Err()),
		)
		return
	}
}

func bodyReservation(request *http.Request, maximum int64) (int64, *localError) {
	if request.Body == nil || request.Body == http.NoBody {
		return 0, nil
	}
	if request.ContentLength > maximum {
		return 0, newLocalError(http.StatusRequestEntityTooLarge, "proxy_request_too_large", "request body exceeds configured limit")
	}
	if request.ContentLength > 0 {
		return request.ContentLength, nil
	}
	return maximum, nil
}

func validateForwardRoute(request *http.Request) *localError {
	if request.Method != http.MethodPost {
		return newLocalError(http.StatusMethodNotAllowed, "proxy_method_not_allowed", "inference routes require POST")
	}
	if request.URL == nil || !strings.HasPrefix(request.URL.Path, "/v1/") {
		return newLocalError(http.StatusNotFound, "proxy_not_found", "route not found")
	}
	if hasUnsafePathSegment(request.URL) {
		return newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request path contains a forbidden segment")
	}
	if isManagementRoute(request.URL.Path) {
		return newLocalError(http.StatusNotFound, "proxy_not_found", "route not found")
	}
	return nil
}

// hasUnsafePathSegment rejects all encoded path forms before forwarding. Model
// IDs with escaped slashes are handled by the local model endpoint; inference
// route names have no need for encoding. This also prevents encoded management
// namespaces, encoded slashes, and layered dot-segment normalization upstream.
func hasUnsafePathSegment(target *url.URL) bool {
	if target == nil || target.EscapedPath() != target.Path ||
		strings.Contains(target.Path, "\\") || strings.Contains(target.Path, "//") {
		return true
	}
	for _, segment := range strings.Split(target.Path, "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func isManagementRoute(path string) bool {
	remainder := strings.TrimPrefix(path, "/v1/")
	root, _, _ := strings.Cut(remainder, "/")
	switch strings.ToLower(root) {
	case "assistants", "batches", "containers", "conversations", "evals",
		"files", "fine-tuning", "fine_tuning", "models", "organization",
		"projects", "threads", "uploads", "vector_stores", "webhooks":
		return true
	default:
		return false
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
	if len(body) == 0 {
		return "", newLocalError(http.StatusBadRequest, "proxy_model_required", "request must contain an allowed model")
	}

	contentEncodings := request.Header.Values("Content-Encoding")
	contentEncoding := strings.TrimSpace(strings.Join(contentEncodings, ","))
	if contentEncoding != "" && !strings.EqualFold(contentEncoding, "identity") {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "encoded inference request bodies are not supported")
	}

	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) > 1 {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "inference request content type is ambiguous")
	}
	contentType := strings.TrimSpace(strings.Join(contentTypes, ""))
	if contentType == "" {
		if isMultipartModelRoute(request.URL.Path) || firstNonSpace(body) != '{' {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "inference request body must use a supported media type")
		}
		return h.validateJSONModel(body)
	}
	mediaType, parameters, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "inference request content type is invalid")
	}
	if mediaType == "multipart/form-data" {
		if !isMultipartModelRoute(request.URL.Path) {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "multipart inference is not supported for this route")
		}
		return h.validateMultipartModel(body, parameters["boundary"])
	}
	if isMultipartModelRoute(request.URL.Path) || !isJSONMediaType(mediaType) {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "inference request body must use a supported media type")
	}
	return h.validateJSONModel(body)
}

func (h *Handler) validateJSONModel(body []byte) (string, *localError) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
	}
	var rawModel json.RawMessage
	modelFields := 0
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
		}
		name, ok := key.(string)
		if !ok {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
		}
		if name == "model" {
			modelFields++
			rawModel = value
		}
	}
	if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must be a JSON object")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "request body must contain exactly one JSON object")
	}
	if modelFields == 0 {
		return "", newLocalError(http.StatusBadRequest, "proxy_model_required", "request must contain an allowed model")
	}
	if modelFields != 1 {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_model", "request must contain exactly one model field")
	}
	var model string
	if err := json.Unmarshal(rawModel, &model); err != nil {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_model", "model must be a non-empty string")
	}
	return h.validateModelName(model)
}

func (h *Handler) validateMultipartModel(body []byte, boundary string) (string, *localError) {
	if boundary == "" {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "multipart inference boundary is required")
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	var model string
	found := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "multipart inference body is invalid")
		}
		if part.FormName() != "model" {
			continue
		}
		if found || part.FileName() != "" {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_model", "multipart inference must contain exactly one model field")
		}
		value, err := io.ReadAll(part)
		if err != nil {
			return "", newLocalError(http.StatusBadRequest, "proxy_invalid_request", "multipart model field could not be read")
		}
		model = string(value)
		found = true
	}
	if !found {
		return "", newLocalError(http.StatusBadRequest, "proxy_model_required", "request must contain an allowed model")
	}
	return h.validateModelName(model)
}

func (h *Handler) validateModelName(model string) (string, *localError) {
	if strings.TrimSpace(model) == "" || model != strings.TrimSpace(model) {
		return "", newLocalError(http.StatusBadRequest, "proxy_invalid_model", "model must be a non-empty string")
	}
	if !h.catalog.Allows(model) {
		return "", newLocalError(http.StatusBadRequest, "proxy_model_not_allowed", "model is not allowed by this provider")
	}
	return model, nil
}

func isMultipartModelRoute(path string) bool {
	switch path {
	case "/v1/audio/transcriptions", "/v1/audio/translations", "/v1/images/edits", "/v1/images/variations":
		return true
	default:
		return false
	}
}

func isJSONMediaType(mediaType string) bool {
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
	if readErr != nil && !errors.Is(readErr, io.EOF) {
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
	snapshot := h.scheduler.Snapshot()
	h.logger.Warn("llm request retry scheduled",
		"request_id", requestID,
		"route", request.URL.Path,
		"model", model,
		"attempt", attempt,
		"upstream_status", status,
		"retry_delay_ms", delay.Milliseconds(),
		"active_attempts", snapshot.ActiveAttempts,
		"queued_attempts", snapshot.QueuedAttempts,
		"admitted_requests", snapshot.AdmittedRequests,
		"effective_rpm", snapshot.EffectiveRPM,
	)
}

func (h *Handler) writeLocalError(w http.ResponseWriter, request *http.Request, requestID, model string, attempts int, started time.Time, localErr *localError) {
	writeError(w, localErr.status, localErr.code, localErr.message)
	snapshot := h.scheduler.Snapshot()
	h.logger.Warn("llm request rejected",
		"request_id", requestID,
		"route", request.URL.Path,
		"model", model,
		"attempts", attempts,
		"status", localErr.status,
		"error_code", localErr.code,
		"active_attempts", snapshot.ActiveAttempts,
		"queued_attempts", snapshot.QueuedAttempts,
		"admitted_requests", snapshot.AdmittedRequests,
		"effective_rpm", snapshot.EffectiveRPM,
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
