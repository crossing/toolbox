// Package config loads and validates llm-pacer's non-secret configuration.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
)

const (
	DefaultListenAddress          = "127.0.0.1:4000"
	DefaultRPM                    = 32.0
	DefaultMaxInflight            = 3
	DefaultQueueLimit             = 128
	MaximumQueueLimit             = 500
	DefaultMaxQueuedBodyBytes     = int64(256 << 20)
	DefaultMaxRequestBodyBytes    = int64(16 << 20)
	DefaultMaxRetries             = 12
	DefaultMaxBackoff             = 300 * time.Second
	DefaultUpstreamRequestTimeout = 1800 * time.Second
	DefaultStreamIdleTimeout      = 1800 * time.Second
	DefaultConnectTimeout         = 30 * time.Second
	DefaultMinAdaptiveRPM         = 1.0
)

// Duration is a JSON duration encoded with time.ParseDuration syntax, for
// example "30s" or "30m". Duration exposes the underlying time.Duration to
// callers without accepting ambiguous numeric nanoseconds in configuration.
type Duration time.Duration

func NewDuration(value time.Duration) Duration { return Duration(value) }

func (d Duration) Duration() time.Duration { return time.Duration(d) }

func (d Duration) String() string { return time.Duration(d).String() }

func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

func (d *Duration) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return fmt.Errorf("duration must be a string: %w", err)
	}
	value, err := time.ParseDuration(text)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", text, err)
	}
	*d = Duration(value)
	return nil
}

// Config deliberately contains no credential fields. The upstream and local
// bearer tokens are supplied separately at process startup.
type Config struct {
	ListenAddress          string                   `json:"listen"`
	UpstreamBaseURL        string                   `json:"upstream_base_url"`
	RPM                    float64                  `json:"rpm"`
	MaxInflight            int                      `json:"max_inflight"`
	QueueLimit             int                      `json:"queue_limit"`
	MaxQueuedBodyBytes     int64                    `json:"max_queued_body_bytes"`
	MaxRequestBodyBytes    int64                    `json:"max_request_body_bytes"`
	MaxRetries             int                      `json:"max_retries"`
	MaxBackoff             Duration                 `json:"max_backoff"`
	UpstreamRequestTimeout Duration                 `json:"upstream_request_timeout"`
	StreamIdleTimeout      Duration                 `json:"stream_idle_timeout"`
	ConnectTimeout         Duration                 `json:"connect_timeout"`
	MinAdaptiveRPM         float64                  `json:"min_adaptive_rpm"`
	Models                 map[string]catalog.Model `json:"models"`

	// Catalog is the validated, normalized view of Models. It is never decoded
	// from or encoded into the configuration file.
	Catalog *catalog.Catalog `json:"-"`
}

// Defaults returns a new configuration with all documented operational
// defaults. UpstreamBaseURL and Models have no safe defaults and must be set by
// the configuration file before Validate succeeds.
func Defaults() Config {
	return Config{
		ListenAddress:          DefaultListenAddress,
		RPM:                    DefaultRPM,
		MaxInflight:            DefaultMaxInflight,
		QueueLimit:             DefaultQueueLimit,
		MaxQueuedBodyBytes:     DefaultMaxQueuedBodyBytes,
		MaxRequestBodyBytes:    DefaultMaxRequestBodyBytes,
		MaxRetries:             DefaultMaxRetries,
		MaxBackoff:             NewDuration(DefaultMaxBackoff),
		UpstreamRequestTimeout: NewDuration(DefaultUpstreamRequestTimeout),
		StreamIdleTimeout:      NewDuration(DefaultStreamIdleTimeout),
		ConnectTimeout:         NewDuration(DefaultConnectTimeout),
		MinAdaptiveRPM:         DefaultMinAdaptiveRPM,
	}
}

// Load decodes exactly one JSON object. Defaults are installed before decoding,
// so omitted values inherit defaults while explicitly supplied zero values are
// retained and rejected by Validate.
func Load(r io.Reader) (*Config, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read configuration: %w", err)
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errors.New("decode configuration: expected one JSON object")
	}

	config := Defaults()
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("decode configuration: %w", err)
	}
	if err := ensureEOF(decoder); err != nil {
		return nil, err
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return errors.New("decode configuration: multiple JSON values")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("decode configuration: %w", err)
	}
	return nil
}

func (c *Config) Validate() error {
	if c == nil {
		return errors.New("configuration is nil")
	}
	if err := validateLoopbackListen(c.ListenAddress); err != nil {
		return err
	}
	normalizedUpstreamBaseURL, err := validateUpstreamBaseURL(c.UpstreamBaseURL)
	if err != nil {
		return err
	}
	c.UpstreamBaseURL = normalizedUpstreamBaseURL
	if err := positiveFinite("rpm", c.RPM); err != nil {
		return err
	}
	if c.MaxInflight <= 0 {
		return errors.New("max_inflight must be positive")
	}
	if c.QueueLimit <= 0 || c.QueueLimit > MaximumQueueLimit {
		return fmt.Errorf("queue_limit must be between 1 and %d", MaximumQueueLimit)
	}
	if c.MaxQueuedBodyBytes <= 0 {
		return errors.New("max_queued_body_bytes must be positive")
	}
	if c.MaxRequestBodyBytes <= 0 {
		return errors.New("max_request_body_bytes must be positive")
	}
	if c.MaxRequestBodyBytes > c.MaxQueuedBodyBytes {
		return errors.New("max_request_body_bytes must not exceed max_queued_body_bytes")
	}
	if c.MaxRetries <= 0 {
		return errors.New("max_retries must be positive")
	}
	for _, limit := range []struct {
		name  string
		value Duration
	}{
		{name: "max_backoff", value: c.MaxBackoff},
		{name: "upstream_request_timeout", value: c.UpstreamRequestTimeout},
		{name: "stream_idle_timeout", value: c.StreamIdleTimeout},
		{name: "connect_timeout", value: c.ConnectTimeout},
	} {
		if limit.value.Duration() <= 0 {
			return fmt.Errorf("%s must be positive", limit.name)
		}
	}
	if err := positiveFinite("min_adaptive_rpm", c.MinAdaptiveRPM); err != nil {
		return err
	}
	if c.MinAdaptiveRPM > c.RPM {
		return errors.New("min_adaptive_rpm must not exceed rpm")
	}

	validatedCatalog := &catalog.Catalog{Models: c.Models}
	if err := validatedCatalog.Validate(); err != nil {
		return fmt.Errorf("validate models: %w", err)
	}
	c.Models = validatedCatalog.Models
	c.Catalog = validatedCatalog
	return nil
}

func positiveFinite(name string, value float64) error {
	if value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return fmt.Errorf("%s must be positive and finite", name)
	}
	return nil
}

func validateUpstreamBaseURL(raw string) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return "", errors.New("upstream_base_url must be an absolute HTTP or HTTPS URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Hostname() == "" || parsed.Opaque != "" {
		return "", errors.New("upstream_base_url must be an absolute HTTP or HTTPS URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("upstream_base_url must use http or https")
	}
	if parsed.User != nil {
		return "", errors.New("upstream_base_url must not contain credentials")
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", errors.New("upstream_base_url must not contain a query or fragment")
	}
	parsed.Scheme = scheme
	return parsed.String(), nil
}

func validateLoopbackListen(address string) error {
	host, portText, err := net.SplitHostPort(address)
	if err != nil || host == "" {
		return errors.New("listen must be a loopback host and numeric port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return errors.New("listen must have a port between 1 and 65535")
	}

	if ip := net.ParseIP(host); ip != nil {
		if !ip.IsLoopback() {
			return errors.New("listen must resolve only to loopback addresses")
		}
		return nil
	}

	if !strings.EqualFold(host, "localhost") {
		return errors.New("listen host must be localhost or a literal loopback address")
	}
	return nil
}
