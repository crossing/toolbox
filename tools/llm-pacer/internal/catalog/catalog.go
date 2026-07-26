package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

const defaultOwner = "upstream"

var openCodeModalities = map[string]struct{}{
	"audio": {},
	"image": {},
	"pdf":   {},
	"text":  {},
	"video": {},
}

// Catalog is the single source of truth for models accepted and advertised by
// llm-pacer. The map keys are both upstream model IDs and the allowlist.
type Catalog struct {
	Models map[string]Model `json:"models"`
}

type Model struct {
	Name         string       `json:"name,omitempty"`
	Owner        string       `json:"owner,omitempty"`
	Created      int64        `json:"created,omitempty"`
	Limits       Limits       `json:"limits,omitempty"`
	Capabilities Capabilities `json:"capabilities,omitempty"`
	Modalities   Modalities   `json:"modalities,omitempty"`
}

type Limits struct {
	Context int64 `json:"context,omitempty"`
	Output  int64 `json:"output,omitempty"`
}

type Capabilities struct {
	ToolCall    *bool `json:"tool_call,omitempty"`
	Reasoning   *bool `json:"reasoning,omitempty"`
	Attachment  *bool `json:"attachment,omitempty"`
	Temperature *bool `json:"temperature,omitempty"`
}

type Modalities struct {
	Input  []string `json:"input,omitempty"`
	Output []string `json:"output,omitempty"`
}

type OpenAIList struct {
	Object string        `json:"object"`
	Data   []OpenAIModel `json:"data"`
}

type OpenAIModel struct {
	ID       string        `json:"id"`
	Object   string        `json:"object"`
	Created  int64         `json:"created"`
	OwnedBy  string        `json:"owned_by"`
	LLMPacer LLMPacerModel `json:"x-llm-pacer"`
}

type LLMPacerModel struct {
	Name            string       `json:"name"`
	ContextWindow   int64        `json:"context_window,omitempty"`
	MaxOutputTokens int64        `json:"max_output_tokens,omitempty"`
	Capabilities    Capabilities `json:"capabilities,omitempty"`
	Modalities      Modalities   `json:"modalities,omitempty"`
}

type OpenCodeModel struct {
	Name        string      `json:"name"`
	Limit       *Limits     `json:"limit,omitempty"`
	ToolCall    *bool       `json:"tool_call,omitempty"`
	Reasoning   *bool       `json:"reasoning,omitempty"`
	Attachment  *bool       `json:"attachment,omitempty"`
	Temperature *bool       `json:"temperature,omitempty"`
	Modalities  *Modalities `json:"modalities,omitempty"`
}

func Load(r io.Reader) (*Catalog, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()

	var c Catalog
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("decode model catalog: %w", err)
	}
	if err := ensureEOF(dec); err != nil {
		return nil, err
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func ensureEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); err == nil {
		return errors.New("decode model catalog: multiple JSON values")
	} else if !errors.Is(err, io.EOF) {
		return fmt.Errorf("decode model catalog: %w", err)
	}
	return nil
}

func (c *Catalog) Validate() error {
	if c == nil || len(c.Models) == 0 {
		return errors.New("model catalog must contain at least one model")
	}

	for id, model := range c.Models {
		if strings.TrimSpace(id) == "" {
			return errors.New("model catalog contains an empty model ID")
		}
		if strings.TrimSpace(model.Name) == "" {
			model.Name = id
		}
		if strings.TrimSpace(model.Owner) == "" {
			model.Owner = defaultOwner
		}
		if model.Created < 0 {
			return fmt.Errorf("model %q has a negative created timestamp", id)
		}
		if model.Limits.Context < 0 || model.Limits.Output < 0 {
			return fmt.Errorf("model %q has a negative token limit", id)
		}
		if (model.Limits.Context == 0) != (model.Limits.Output == 0) {
			return fmt.Errorf("model %q must set both context and output token limits", id)
		}
		defaultCapabilities(&model.Capabilities)
		if err := validateModalities(id, model.Modalities); err != nil {
			return err
		}
		c.Models[id] = model
	}
	return nil
}

func defaultCapabilities(capabilities *Capabilities) {
	if capabilities.ToolCall == nil {
		capabilities.ToolCall = boolPtr(false)
	}
	if capabilities.Reasoning == nil {
		capabilities.Reasoning = boolPtr(false)
	}
	if capabilities.Attachment == nil {
		capabilities.Attachment = boolPtr(false)
	}
	if capabilities.Temperature == nil {
		capabilities.Temperature = boolPtr(false)
	}
}

func boolPtr(value bool) *bool { return &value }

func validateModalities(id string, modalities Modalities) error {
	for _, values := range [][]string{modalities.Input, modalities.Output} {
		for _, value := range values {
			if _, ok := openCodeModalities[value]; !ok {
				return fmt.Errorf("model %q contains unsupported modality %q", id, value)
			}
		}
	}
	return nil
}

func (c *Catalog) Allows(id string) bool {
	if c == nil {
		return false
	}
	_, ok := c.Models[id]
	return ok
}

func (c *Catalog) IDs() []string {
	ids := make([]string, 0, len(c.Models))
	for id := range c.Models {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (c *Catalog) OpenAIList() OpenAIList {
	data := make([]OpenAIModel, 0, len(c.Models))
	for _, id := range c.IDs() {
		data = append(data, c.OpenAIModel(id))
	}
	return OpenAIList{Object: "list", Data: data}
}

func (c *Catalog) OpenAIModel(id string) OpenAIModel {
	model := c.Models[id]
	return OpenAIModel{
		ID:      id,
		Object:  "model",
		Created: model.Created,
		OwnedBy: model.Owner,
		LLMPacer: LLMPacerModel{
			Name:            model.Name,
			ContextWindow:   model.Limits.Context,
			MaxOutputTokens: model.Limits.Output,
			Capabilities:    model.Capabilities,
			Modalities:      model.Modalities,
		},
	}
}

func (c *Catalog) OpenCodeModels() map[string]OpenCodeModel {
	result := make(map[string]OpenCodeModel, len(c.Models))
	for id, model := range c.Models {
		entry := OpenCodeModel{
			Name:        model.Name,
			ToolCall:    model.Capabilities.ToolCall,
			Reasoning:   model.Capabilities.Reasoning,
			Attachment:  model.Capabilities.Attachment,
			Temperature: model.Capabilities.Temperature,
		}
		if model.Limits.Context > 0 && model.Limits.Output > 0 {
			limits := model.Limits
			entry.Limit = &limits
		}
		if len(model.Modalities.Input) > 0 || len(model.Modalities.Output) > 0 {
			modalities := model.Modalities
			entry.Modalities = &modalities
		}
		result[id] = entry
	}
	return result
}
