package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
)

type Snapshot struct {
	OK             bool    `json:"ok"`
	ConfiguredRPM  float64 `json:"configured_rpm"`
	EffectiveRPM   float64 `json:"effective_rpm"`
	MaxInflight    int     `json:"max_inflight"`
	Active         int     `json:"active"`
	Queued         int     `json:"queued"`
	BackingOff     int     `json:"backing_off"`
	QueueLimit     int     `json:"queue_limit"`
	QueuedBytes    int64   `json:"queued_bytes"`
	MaxQueuedBytes int64   `json:"max_queued_bytes"`
}

type Snapshotter interface {
	Snapshot() Snapshot
}

type staticSnapshotter struct{}

func (staticSnapshotter) Snapshot() Snapshot { return Snapshot{OK: true} }

type Handler struct {
	catalog      *catalog.Catalog
	localAPIKey  []byte
	snapshotter  Snapshotter
	inferenceAPI http.Handler
}

func New(models *catalog.Catalog, localAPIKey string, snapshotter Snapshotter, inferenceAPI http.Handler) *Handler {
	if snapshotter == nil {
		snapshotter = staticSnapshotter{}
	}
	if inferenceAPI == nil {
		inferenceAPI = http.NotFoundHandler()
	}
	return &Handler{
		catalog:      models,
		localAPIKey:  []byte(localAPIKey),
		snapshotter:  snapshotter,
		inferenceAPI: inferenceAPI,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/healthz":
		h.serveHealth(w, r)
	case r.URL.Path == "/v1/models":
		if !h.authorize(w, r) {
			return
		}
		h.serveModels(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/models/"):
		if !h.authorize(w, r) {
			return
		}
		h.serveModel(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/"):
		if !h.authorize(w, r) {
			return
		}
		h.inferenceAPI.ServeHTTP(w, r)
	default:
		writeError(w, http.StatusNotFound, "proxy_not_found", "route not found")
	}
}

func (h *Handler) serveHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, h.snapshotter.Snapshot())
}

func (h *Handler) serveModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, h.catalog.OpenAIList())
}

func (h *Handler) serveModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	escaped := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/models/")
	id, err := url.PathUnescape(escaped)
	if err != nil || id == "" || !h.catalog.Allows(id) {
		writeError(w, http.StatusNotFound, "model_not_found", "model not found")
		return
	}
	writeJSON(w, http.StatusOK, h.catalog.OpenAIModel(id))
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) bool {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		writeError(w, http.StatusUnauthorized, "proxy_unauthorized", "missing or invalid local API key")
		return false
	}
	presented := []byte(strings.TrimPrefix(header, prefix))
	if len(presented) != len(h.localAPIKey) || subtle.ConstantTimeCompare(presented, h.localAPIKey) != 1 {
		writeError(w, http.StatusUnauthorized, "proxy_unauthorized", "missing or invalid local API key")
		return false
	}
	return true
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, "proxy_method_not_allowed", "method not allowed")
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorEnvelope{Error: errorBody{Message: message, Type: code, Code: code}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
