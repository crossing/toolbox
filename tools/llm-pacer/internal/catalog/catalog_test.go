package catalog

import (
	"strings"
	"testing"
)

func TestLoadAndExport(t *testing.T) {
	raw := `{
  "models": {
    "z/model": {"name":"Zed","owner":"vendor-z"},
    "a/model": {
      "name":"Alpha",
      "limits":{"context":131072,"output":16384},
      "capabilities":{"tool_call":true,"reasoning":false},
      "modalities":{"input":["text"],"output":["text"]}
    }
  }
}`

	c, err := Load(strings.NewReader(raw))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got, want := c.IDs(), []string{"a/model", "z/model"}; !equalStrings(got, want) {
		t.Fatalf("IDs() = %v, want %v", got, want)
	}
	if !c.Allows("a/model") || c.Allows("missing") {
		t.Fatal("allowlist did not match catalog keys")
	}

	listed := c.OpenAIList()
	if listed.Object != "list" || len(listed.Data) != 2 {
		t.Fatalf("OpenAIList() = %#v", listed)
	}
	if listed.Data[0].ID != "a/model" || listed.Data[0].OwnedBy != defaultOwner {
		t.Fatalf("first OpenAI model = %#v", listed.Data[0])
	}
	if listed.Data[0].LLMPacer.ContextWindow != 131072 {
		t.Fatalf("extension metadata = %#v", listed.Data[0].LLMPacer)
	}

	openCode := c.OpenCodeModels()["a/model"]
	if openCode.Limit == nil || openCode.Limit.Output != 16384 {
		t.Fatalf("OpenCode limit = %#v", openCode.Limit)
	}
	if openCode.ToolCall == nil || *openCode.ToolCall != true {
		t.Fatalf("OpenCode tool_call = %#v", openCode.ToolCall)
	}
	if openCode.Reasoning == nil || *openCode.Reasoning != false {
		t.Fatalf("OpenCode reasoning = %#v", openCode.Reasoning)
	}
}

func TestLoadDefaultsNameAndOwner(t *testing.T) {
	c, err := Load(strings.NewReader(`{"models":{"vendor/model":{}}}`))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	model := c.Models["vendor/model"]
	if model.Name != "vendor/model" || model.Owner != defaultOwner {
		t.Fatalf("defaults = %#v", model)
	}
	for name, value := range map[string]*bool{
		"tool_call":   model.Capabilities.ToolCall,
		"reasoning":   model.Capabilities.Reasoning,
		"attachment":  model.Capabilities.Attachment,
		"temperature": model.Capabilities.Temperature,
	} {
		if value == nil || *value {
			t.Fatalf("default %s = %#v, want explicit false", name, value)
		}
	}
}

func TestLoadRejectsInvalidCatalogs(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "empty", raw: `{"models":{}}`},
		{name: "negative limit", raw: `{"models":{"m":{"limits":{"context":-1}}}}`},
		{name: "context limit only", raw: `{"models":{"m":{"limits":{"context":1024}}}}`},
		{name: "output limit only", raw: `{"models":{"m":{"limits":{"output":1024}}}}`},
		{name: "empty modality", raw: `{"models":{"m":{"modalities":{"input":[""]}}}}`},
		{name: "unknown modality", raw: `{"models":{"m":{"modalities":{"input":["documents"]}}}}`},
		{name: "wrong case modality", raw: `{"models":{"m":{"modalities":{"output":["Text"]}}}}`},
		{name: "unknown field", raw: `{"models":{"m":{"surprise":true}}}`},
		{name: "multiple values", raw: `{"models":{"m":{}}} {}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Load(strings.NewReader(tt.raw)); err == nil {
				t.Fatal("Load() unexpectedly succeeded")
			}
		})
	}
}

func TestCapabilitiesPreserveExplicitFalse(t *testing.T) {
	model := Model{
		Name: "model",
		Capabilities: Capabilities{
			ToolCall:  boolPtr(false),
			Reasoning: boolPtr(false),
		},
	}
	c := &Catalog{Models: map[string]Model{"model": model}}
	if err := c.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	got := c.OpenCodeModels()["model"]
	if got.ToolCall == nil || *got.ToolCall {
		t.Fatalf("tool_call = %#v, want explicit false", got.ToolCall)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
