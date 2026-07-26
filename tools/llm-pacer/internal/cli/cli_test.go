package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const testConfigJSON = `{
  "upstream_base_url": "https://upstream.example.invalid/openai",
  "models": {
    "vendor/model": {
      "name": "Vendor Model",
      "owner": "fixture-owner",
      "created": 123,
      "limits": {"context": 4096, "output": 512},
      "capabilities": {"tool_call": true, "reasoning": false, "attachment": false, "temperature": true},
      "modalities": {"input": ["text"], "output": ["text"]}
    },
    "alpha": {"name": "Alpha"}
  }
}`

type runResult struct {
	exitCode int
	stdout   bytes.Buffer
	stderr   bytes.Buffer
}

func runCLI(arguments []string, dependencies Dependencies) runResult {
	var result runResult
	dependencies.Stdout = &result.stdout
	dependencies.Stderr = &result.stderr
	result.exitCode = Run(arguments, dependencies)
	return result
}

func writeConfigFixture(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "llm-pacer.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCheckConfigJSONAndHumanOutput(t *testing.T) {
	path := writeConfigFixture(t, testConfigJSON)
	for _, test := range []struct {
		name      string
		arguments []string
		human     bool
	}{
		{name: "compact JSON", arguments: []string{"check-config", "--config", path}},
		{name: "human JSON", arguments: []string{"check-config", "--config", path, "--human"}, human: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := runCLI(test.arguments, Dependencies{})
			if result.exitCode != 0 {
				t.Fatalf("exit code = %d, want 0; stderr=%s", result.exitCode, result.stderr.String())
			}
			if result.stderr.Len() != 0 {
				t.Fatalf("stderr is not empty: %s", result.stderr.String())
			}
			var output struct {
				OK     bool     `json:"ok"`
				Listen string   `json:"listen"`
				Models []string `json:"models"`
			}
			if err := json.Unmarshal(result.stdout.Bytes(), &output); err != nil {
				t.Fatalf("decode stdout: %v", err)
			}
			if !output.OK || output.Listen != "127.0.0.1:4000" {
				t.Fatalf("check-config output = %+v", output)
			}
			if len(output.Models) != 2 || output.Models[0] != "alpha" || output.Models[1] != "vendor/model" {
				t.Fatalf("models = %v", output.Models)
			}
			indented := bytes.Contains(result.stdout.Bytes(), []byte("\n  \""))
			if indented != test.human {
				t.Fatalf("indented output = %v, want %v", indented, test.human)
			}
		})
	}
}

func TestExportModelsOpenAIAndOpenCode(t *testing.T) {
	path := writeConfigFixture(t, testConfigJSON)

	openAI := runCLI([]string{"export-models", "--config", path, "--format", "openai"}, Dependencies{})
	if openAI.exitCode != 0 || openAI.stderr.Len() != 0 {
		t.Fatalf("OpenAI export failed: exit=%d stderr=%s", openAI.exitCode, openAI.stderr.String())
	}
	var openAIOutput struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			Object  string `json:"object"`
			OwnedBy string `json:"owned_by"`
			Pacer   struct {
				Name          string `json:"name"`
				ContextWindow int64  `json:"context_window"`
			} `json:"x-llm-pacer"`
		} `json:"data"`
	}
	if err := json.Unmarshal(openAI.stdout.Bytes(), &openAIOutput); err != nil {
		t.Fatal(err)
	}
	if openAIOutput.Object != "list" || len(openAIOutput.Data) != 2 || openAIOutput.Data[0].ID != "alpha" || openAIOutput.Data[1].ID != "vendor/model" {
		t.Fatalf("OpenAI export shape = %+v", openAIOutput)
	}
	if openAIOutput.Data[1].Object != "model" || openAIOutput.Data[1].OwnedBy != "fixture-owner" || openAIOutput.Data[1].Pacer.Name != "Vendor Model" || openAIOutput.Data[1].Pacer.ContextWindow != 4096 {
		t.Fatalf("OpenAI model metadata = %+v", openAIOutput.Data[1])
	}

	openCode := runCLI([]string{"export-models", "--config", path, "--format", "opencode", "--human"}, Dependencies{})
	if openCode.exitCode != 0 || openCode.stderr.Len() != 0 {
		t.Fatalf("OpenCode export failed: exit=%d stderr=%s", openCode.exitCode, openCode.stderr.String())
	}
	var openCodeOutput map[string]struct {
		Name        string `json:"name"`
		ToolCall    bool   `json:"tool_call"`
		Temperature bool   `json:"temperature"`
		Limit       struct {
			Context int64 `json:"context"`
			Output  int64 `json:"output"`
		} `json:"limit"`
	}
	if err := json.Unmarshal(openCode.stdout.Bytes(), &openCodeOutput); err != nil {
		t.Fatal(err)
	}
	vendor, ok := openCodeOutput["vendor/model"]
	if !ok || vendor.Name != "Vendor Model" || !vendor.ToolCall || !vendor.Temperature || vendor.Limit.Context != 4096 || vendor.Limit.Output != 512 {
		t.Fatalf("OpenCode model metadata = %+v, present=%v", vendor, ok)
	}
	if !bytes.Contains(openCode.stdout.Bytes(), []byte("\n  \"")) {
		t.Fatal("--human export is not indented")
	}
}

func TestUsageAndConfigurationErrorsAreStructured(t *testing.T) {
	validConfig := writeConfigFixture(t, testConfigJSON)
	invalidConfig := writeConfigFixture(t, `{"upstream_base_url":"https://upstream.example.invalid","unknown":true,"models":{"fake":{}}}`)
	for _, test := range []struct {
		name      string
		arguments []string
		wantCode  string
	}{
		{name: "missing command", arguments: nil, wantCode: "usage"},
		{name: "unknown command", arguments: []string{"not-a-command"}, wantCode: "unknown_command"},
		{name: "missing flag", arguments: []string{"check-config"}, wantCode: "usage"},
		{name: "invalid format", arguments: []string{"export-models", "--config", validConfig, "--format", "yaml"}, wantCode: "usage"},
		{name: "invalid config", arguments: []string{"check-config", "--config", invalidConfig}, wantCode: "invalid_config"},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := runCLI(test.arguments, Dependencies{})
			if result.exitCode != 2 {
				t.Fatalf("exit code = %d, want 2", result.exitCode)
			}
			if result.stdout.Len() != 0 {
				t.Fatalf("stdout is not empty: %s", result.stdout.String())
			}
			var envelope struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(result.stderr.Bytes(), &envelope); err != nil {
				t.Fatalf("stderr is not structured JSON: %v", err)
			}
			if envelope.Error.Code != test.wantCode || envelope.Error.Message == "" {
				t.Fatalf("error = %+v, want code %q", envelope.Error, test.wantCode)
			}
		})
	}
}

func TestCredentialWriteIsSilentAndProtected(t *testing.T) {
	const fakeCredential = "fixture-credential-value"
	destination := filepath.Join(t.TempDir(), "credential")
	result := runCLI([]string{"credential-write", destination}, Dependencies{Stdin: strings.NewReader(fakeCredential)})
	if result.exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", result.exitCode)
	}
	if result.stdout.Len() != 0 || result.stderr.Len() != 0 {
		t.Fatalf("credential-write emitted output: stdout=%q stderr=%q", result.stdout.String(), result.stderr.String())
	}
	value, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(value) != fakeCredential {
		t.Fatal("credential destination does not contain the supplied value")
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o400 {
		t.Fatalf("credential mode = %#o, want 0400", got)
	}

	failure := runCLI([]string{"credential-write", destination}, Dependencies{Stdin: strings.NewReader(fakeCredential)})
	if failure.exitCode != 1 || failure.stdout.Len() != 0 {
		t.Fatalf("exclusive write failure = exit %d stdout %q", failure.exitCode, failure.stdout.String())
	}
	if bytes.Contains(failure.stderr.Bytes(), []byte(fakeCredential)) {
		t.Fatal("credential value leaked to stderr")
	}
	var envelope map[string]any
	if err := json.Unmarshal(failure.stderr.Bytes(), &envelope); err != nil {
		t.Fatalf("failure stderr is not JSON: %v", err)
	}
}

func TestExecWithLocalTokenUsesInheritedDescriptorAndReplacesEnvironment(t *testing.T) {
	const fakeToken = "fixture-local-token"
	readEnd, writeEnd, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writeEnd.Write([]byte(fakeToken)); err != nil {
		t.Fatal(err)
	}
	if err := writeEnd.Close(); err != nil {
		t.Fatal(err)
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var capturedPath string
	var capturedArguments, capturedEnvironment []string
	execCalled := false
	result := runCLI([]string{
		"exec-with-local-token",
		"--fd", strconv.FormatUint(uint64(readEnd.Fd()), 10),
		"--", executable, "alpha", "--beta",
	}, Dependencies{
		Environ: func() []string {
			return []string{"FIRST=1", localAPIKeyEnv + "=old-one", "MIDDLE=2", localAPIKeyEnv + "=old-two"}
		},
		Exec: func(path string, arguments, environment []string) error {
			execCalled = true
			capturedPath = path
			capturedArguments = append([]string(nil), arguments...)
			capturedEnvironment = append([]string(nil), environment...)
			return nil
		},
	})
	if result.exitCode != 0 || !execCalled {
		t.Fatalf("exec wrapper = exit %d called %v", result.exitCode, execCalled)
	}
	if result.stdout.Len() != 0 || result.stderr.Len() != 0 {
		t.Fatalf("exec wrapper emitted output: stdout=%q stderr=%q", result.stdout.String(), result.stderr.String())
	}
	if capturedPath != executable {
		t.Fatalf("exec path = %q, want test executable", capturedPath)
	}
	wantArguments := []string{executable, "alpha", "--beta"}
	if len(capturedArguments) != len(wantArguments) {
		t.Fatalf("argument count = %d, want %d", len(capturedArguments), len(wantArguments))
	}
	for index := range wantArguments {
		if capturedArguments[index] != wantArguments[index] {
			t.Fatalf("argument %d mismatch", index)
		}
	}
	tokenEntries := 0
	for _, entry := range capturedEnvironment {
		if strings.HasPrefix(entry, localAPIKeyEnv+"=") {
			tokenEntries++
			if entry != localAPIKeyEnv+"="+fakeToken {
				t.Fatal("exec environment contains an unexpected local token value")
			}
		}
	}
	if tokenEntries != 1 {
		t.Fatalf("local token environment entries = %d, want 1", tokenEntries)
	}
	if len(capturedEnvironment) != 3 || capturedEnvironment[0] != "FIRST=1" || capturedEnvironment[1] != "MIDDLE=2" {
		t.Fatalf("non-token environment was not preserved: count=%d", len(capturedEnvironment))
	}
	if bytes.Contains(result.stdout.Bytes(), []byte(fakeToken)) || bytes.Contains(result.stderr.Bytes(), []byte(fakeToken)) {
		t.Fatal("local token leaked to command output")
	}
}

func TestExecWithLocalTokenMasksExecFailure(t *testing.T) {
	const fakeToken = "fixture-token-for-failure"
	readEnd, writeEnd, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writeEnd.Write([]byte(fakeToken)); err != nil {
		t.Fatal(err)
	}
	if err := writeEnd.Close(); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	result := runCLI([]string{"exec-with-local-token", "--fd", strconv.FormatUint(uint64(readEnd.Fd()), 10), "--", executable}, Dependencies{
		Exec: func(string, []string, []string) error { return errors.New("injected failure") },
	})
	if result.exitCode != 1 || result.stdout.Len() != 0 {
		t.Fatalf("exec failure = exit %d stdout %q", result.exitCode, result.stdout.String())
	}
	if bytes.Contains(result.stderr.Bytes(), []byte(fakeToken)) || bytes.Contains(result.stderr.Bytes(), []byte("injected failure")) {
		t.Fatal("exec failure leaked sensitive implementation data")
	}
}
