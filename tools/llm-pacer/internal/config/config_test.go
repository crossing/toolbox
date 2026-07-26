package config

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const minimalConfig = `{
  "upstream_base_url": "https://provider.invalid",
  "models": {"vendor/model": {}}
}`

func TestLoadAppliesDocumentedDefaultsAndBuildsCatalog(t *testing.T) {
	config, err := Load(strings.NewReader(minimalConfig))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if config.ListenAddress != DefaultListenAddress ||
		config.RPM != DefaultRPM ||
		config.MaxInflight != DefaultMaxInflight ||
		config.QueueLimit != DefaultQueueLimit ||
		config.MaxQueuedBodyBytes != DefaultMaxQueuedBodyBytes ||
		config.MaxRequestBodyBytes != DefaultMaxRequestBodyBytes ||
		config.MaxRetries != DefaultMaxRetries ||
		config.MaxBackoff.Duration() != DefaultMaxBackoff ||
		config.UpstreamRequestTimeout.Duration() != DefaultUpstreamRequestTimeout ||
		config.StreamIdleTimeout.Duration() != DefaultStreamIdleTimeout ||
		config.ConnectTimeout.Duration() != DefaultConnectTimeout ||
		config.MinAdaptiveRPM != DefaultMinAdaptiveRPM {
		t.Fatalf("documented defaults not applied: %#v", config)
	}
	if config.Catalog == nil || !config.Catalog.Allows("vendor/model") {
		t.Fatalf("validated catalog not exposed: %#v", config.Catalog)
	}
	if got := config.Models["vendor/model"].Name; got != "vendor/model" {
		t.Fatalf("normalized model name = %q, want vendor/model", got)
	}
}

func TestLoadOverridesDefaultsAndParsesDurations(t *testing.T) {
	raw := `{
      "listen": "[::1]:4321",
		"upstream_base_url": "http://127.0.0.1:9000/openai",
      "rpm": 7.5,
      "max_inflight": 2,
      "queue_limit": 25,
      "max_queued_body_bytes": 2048,
      "max_request_body_bytes": 1024,
      "max_retries": 3,
      "max_backoff": "45s",
      "upstream_request_timeout": "45m",
      "stream_idle_timeout": "20m",
      "connect_timeout": "5s",
      "min_adaptive_rpm": 0.5,
      "models": {"mock": {"name": "Mock"}}
    }`
	config, err := Load(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.ListenAddress != "[::1]:4321" || config.RPM != 7.5 || config.MaxInflight != 2 {
		t.Fatalf("overrides not decoded: %#v", config)
	}
	if config.MaxBackoff.Duration() != 45*time.Second || config.UpstreamRequestTimeout.Duration() != 45*time.Minute {
		t.Fatalf("durations not decoded: %#v", config)
	}

	encoded, err := json.Marshal(config.MaxBackoff)
	if err != nil {
		t.Fatalf("MarshalJSON() error = %v", err)
	}
	if string(encoded) != `"45s"` {
		t.Fatalf("marshaled duration = %s, want %q", encoded, `"45s"`)
	}
}

func TestLoadRequiresOneStrictJSONObject(t *testing.T) {
	tests := map[string]string{
		"empty":               "",
		"null":                "null",
		"array":               "[]",
		"multiple objects":    minimalConfig + ` {}`,
		"unknown top field":   strings.Replace(minimalConfig, `"models"`, `"surprise": true, "models"`, 1),
		"unknown model field": strings.Replace(minimalConfig, `{}}`, `{"surprise": true}}`, 1),
		"credential field":    strings.Replace(minimalConfig, `"models"`, `"api_key": "not-a-real-secret", "models"`, 1),
		"numeric duration":    strings.Replace(minimalConfig, `"models"`, `"max_backoff": 300, "models"`, 1),
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(strings.NewReader(raw)); err == nil {
				t.Fatal("Load() error = nil, want rejection")
			}
		})
	}
}

func TestLoadValidatesLoopbackListenAndUpstreamURL(t *testing.T) {
	tests := map[string]string{
		"wildcard listen":        `{"listen":"0.0.0.0:4000","upstream_base_url":"https://provider.invalid/v1","models":{"m":{}}}`,
		"non-loopback listen":    `{"listen":"192.0.2.10:4000","upstream_base_url":"https://provider.invalid/v1","models":{"m":{}}}`,
		"unresolved host listen": `{"listen":"loopback.invalid:4000","upstream_base_url":"https://provider.invalid/v1","models":{"m":{}}}`,
		"missing listen port":    `{"listen":"127.0.0.1","upstream_base_url":"https://provider.invalid/v1","models":{"m":{}}}`,
		"zero listen port":       `{"listen":"127.0.0.1:0","upstream_base_url":"https://provider.invalid/v1","models":{"m":{}}}`,
		"relative upstream":      `{"upstream_base_url":"/v1","models":{"m":{}}}`,
		"unsupported scheme":     `{"upstream_base_url":"ftp://provider.invalid/v1","models":{"m":{}}}`,
		"missing upstream host":  `{"upstream_base_url":"https:///v1","models":{"m":{}}}`,
		"URL credentials":        `{"upstream_base_url":"https://user:password@provider.invalid/v1","models":{"m":{}}}`,
		"URL query":              `{"upstream_base_url":"https://provider.invalid/v1?key=value","models":{"m":{}}}`,
		"URL fragment":           `{"upstream_base_url":"https://provider.invalid/v1#token","models":{"m":{}}}`,
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(strings.NewReader(raw)); err == nil {
				t.Fatal("Load() error = nil, want rejection")
			}
		})
	}

	localhostConfig := strings.Replace(minimalConfig, `"upstream_base_url"`, `"listen":"localhost:4000","upstream_base_url"`, 1)
	if _, err := Load(strings.NewReader(localhostConfig)); err != nil {
		t.Fatalf("localhost loopback rejected: %v", err)
	}
}

func TestLoadValidatesLimitsAndExplicitZero(t *testing.T) {
	tests := map[string]string{
		"zero rpm":                  `"rpm":0`,
		"negative rpm":              `"rpm":-1`,
		"zero inflight":             `"max_inflight":0`,
		"zero queue":                `"queue_limit":0`,
		"queue over hard limit":     `"queue_limit":501`,
		"zero queued bytes":         `"max_queued_body_bytes":0`,
		"zero request bytes":        `"max_request_body_bytes":0`,
		"request exceeds budget":    `"max_queued_body_bytes":100,"max_request_body_bytes":101`,
		"zero retries":              `"max_retries":0`,
		"zero max backoff":          `"max_backoff":"0s"`,
		"negative upstream timeout": `"upstream_request_timeout":"-1s"`,
		"zero stream idle timeout":  `"stream_idle_timeout":"0s"`,
		"zero connect timeout":      `"connect_timeout":"0s"`,
		"zero minimum rpm":          `"min_adaptive_rpm":0`,
		"minimum above ceiling":     `"rpm":2,"min_adaptive_rpm":3`,
	}
	for name, fields := range tests {
		t.Run(name, func(t *testing.T) {
			raw := `{"upstream_base_url":"https://provider.invalid/v1",` + fields + `,"models":{"m":{}}}`
			if _, err := Load(strings.NewReader(raw)); err == nil {
				t.Fatal("Load() error = nil, want rejection")
			}
		})
	}
}

func TestLoadValidatesEmbeddedCatalog(t *testing.T) {
	tests := map[string]string{
		"missing models": `{"upstream_base_url":"https://provider.invalid/v1"}`,
		"empty models":   `{"upstream_base_url":"https://provider.invalid/v1","models":{}}`,
		"invalid model":  `{"upstream_base_url":"https://provider.invalid/v1","models":{"m":{"limits":{"context":100}}}}`,
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(strings.NewReader(raw)); err == nil {
				t.Fatal("Load() error = nil, want rejection")
			}
		})
	}
}
