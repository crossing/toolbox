package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/config"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/credential"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/daemon"
)

const (
	upstreamCredentialFileEnv = "LLM_PACER_UPSTREAM_API_KEY_FILE"
	localCredentialFileEnv    = "LLM_PACER_LOCAL_API_KEY_FILE"
	localAPIKeyEnv            = "LLM_PACER_API_KEY"
)

var Version = "dev"

type ExecFunc func(path string, argv, environment []string) error

type Dependencies struct {
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
	Getenv  func(string) string
	Environ func() []string
	Exec    ExecFunc
	Context context.Context
}

func SystemDependencies() Dependencies {
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	return Dependencies{
		Stdin:   os.Stdin,
		Stdout:  os.Stdout,
		Stderr:  os.Stderr,
		Getenv:  os.Getenv,
		Environ: os.Environ,
		Exec:    execProcess,
		Context: ctx,
	}
}

func Run(arguments []string, dependencies Dependencies) int {
	dependencies = withDependencyDefaults(dependencies)
	if len(arguments) == 0 {
		return reportError(dependencies.Stderr, &commandError{exitCode: 2, code: "usage", message: usageMessage})
	}

	var err error
	switch arguments[0] {
	case "serve":
		err = serve(arguments[1:], dependencies)
	case "check-config":
		err = checkConfig(arguments[1:], dependencies)
	case "export-models":
		err = exportModels(arguments[1:], dependencies)
	case "credential-write":
		err = credentialWrite(arguments[1:], dependencies)
	case "exec-with-local-token":
		err = execWithLocalToken(arguments[1:], dependencies)
	case "version":
		err = encodeOutput(dependencies.Stdout, map[string]string{"version": Version}, hasHumanFlag(arguments[1:]))
	case "help", "--help", "-h":
		err = encodeOutput(dependencies.Stdout, map[string]string{"usage": usageMessage}, hasHumanFlag(arguments[1:]))
	default:
		err = &commandError{exitCode: 2, code: "unknown_command", message: "unknown llm-pacer command"}
	}
	if err == nil {
		return 0
	}
	return reportError(dependencies.Stderr, err)
}

func withDependencyDefaults(dependencies Dependencies) Dependencies {
	if dependencies.Stdin == nil {
		dependencies.Stdin = strings.NewReader("")
	}
	if dependencies.Stdout == nil {
		dependencies.Stdout = io.Discard
	}
	if dependencies.Stderr == nil {
		dependencies.Stderr = io.Discard
	}
	if dependencies.Getenv == nil {
		dependencies.Getenv = func(string) string { return "" }
	}
	if dependencies.Environ == nil {
		dependencies.Environ = func() []string { return nil }
	}
	if dependencies.Exec == nil {
		dependencies.Exec = execProcess
	}
	if dependencies.Context == nil {
		dependencies.Context = context.Background()
	}
	return dependencies
}

func serve(arguments []string, dependencies Dependencies) error {
	flags := newFlagSet("serve")
	configPath := flags.String("config", "", "path to non-secret JSON configuration")
	if err := flags.Parse(arguments); err != nil {
		return usageError(err)
	}
	if *configPath == "" || flags.NArg() != 0 {
		return usageError(errors.New("serve requires exactly --config PATH"))
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return &commandError{exitCode: 2, code: "invalid_config", message: err.Error()}
	}

	upstreamKey, err := readCredentialFromEnvironment(dependencies, upstreamCredentialFileEnv)
	if err != nil {
		return &commandError{exitCode: 1, code: "credential_error", message: err.Error()}
	}
	defer clear(upstreamKey)
	localKey, err := readCredentialFromEnvironment(dependencies, localCredentialFileEnv)
	if err != nil {
		return &commandError{exitCode: 1, code: "credential_error", message: err.Error()}
	}
	defer clear(localKey)

	logger := slog.New(slog.NewJSONHandler(dependencies.Stderr, nil))
	service, err := daemon.New(cfg, string(upstreamKey), string(localKey), logger)
	if err != nil {
		return &commandError{exitCode: 1, code: "startup_error", message: err.Error()}
	}
	defer service.Close()
	if err := service.Serve(dependencies.Context); err != nil {
		return &commandError{exitCode: 1, code: "serve_error", message: err.Error()}
	}
	return nil
}

func checkConfig(arguments []string, dependencies Dependencies) error {
	flags := newFlagSet("check-config")
	configPath := flags.String("config", "", "path to non-secret JSON configuration")
	human := flags.Bool("human", false, "indent JSON output")
	if err := flags.Parse(arguments); err != nil {
		return usageError(err)
	}
	if *configPath == "" || flags.NArg() != 0 {
		return usageError(errors.New("check-config requires exactly --config PATH"))
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return &commandError{exitCode: 2, code: "invalid_config", message: err.Error()}
	}
	return encodeOutput(dependencies.Stdout, map[string]any{
		"ok":     true,
		"listen": cfg.ListenAddress,
		"models": cfg.Catalog.IDs(),
	}, *human)
}

func exportModels(arguments []string, dependencies Dependencies) error {
	flags := newFlagSet("export-models")
	configPath := flags.String("config", "", "path to non-secret JSON configuration")
	format := flags.String("format", "openai", "openai or opencode")
	human := flags.Bool("human", false, "indent JSON output")
	if err := flags.Parse(arguments); err != nil {
		return usageError(err)
	}
	if *configPath == "" || flags.NArg() != 0 {
		return usageError(errors.New("export-models requires exactly --config PATH"))
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return &commandError{exitCode: 2, code: "invalid_config", message: err.Error()}
	}
	var output any
	switch *format {
	case "openai":
		output = cfg.Catalog.OpenAIList()
	case "opencode":
		output = cfg.Catalog.OpenCodeModels()
	default:
		return usageError(errors.New("export-models --format must be openai or opencode"))
	}
	return encodeOutput(dependencies.Stdout, output, *human)
}

func credentialWrite(arguments []string, dependencies Dependencies) error {
	flags := newFlagSet("credential-write")
	if err := flags.Parse(arguments); err != nil {
		return usageError(err)
	}
	if flags.NArg() != 1 {
		return usageError(errors.New("credential-write requires exactly one destination path"))
	}
	if err := credential.WriteExclusive(flags.Arg(0), dependencies.Stdin, credential.DefaultMaximumBytes); err != nil {
		return &commandError{exitCode: 1, code: "credential_write_error", message: err.Error()}
	}
	return nil
}

func execWithLocalToken(arguments []string, dependencies Dependencies) error {
	flags := newFlagSet("exec-with-local-token")
	credentialFD := flags.Int("fd", -1, "inherited descriptor carrying the local token")
	if err := flags.Parse(arguments); err != nil {
		return usageError(err)
	}
	if *credentialFD <= 2 || flags.NArg() == 0 {
		return usageError(errors.New("exec-with-local-token requires --fd N and a command"))
	}
	file := os.NewFile(uintptr(*credentialFD), "llm-pacer-local-token")
	if file == nil {
		return &commandError{exitCode: 1, code: "credential_error", message: "local token descriptor is invalid"}
	}
	value, err := credential.Read(file, credential.DefaultMaximumBytes)
	_ = file.Close()
	if err != nil {
		return &commandError{exitCode: 1, code: "credential_error", message: err.Error()}
	}
	defer clear(value)

	command := flags.Args()
	path, err := exec.LookPath(command[0])
	if err != nil {
		return &commandError{exitCode: 1, code: "exec_error", message: "requested command was not found"}
	}
	environment := replaceEnvironment(dependencies.Environ(), localAPIKeyEnv, string(value))
	if err := dependencies.Exec(path, command, environment); err != nil {
		return &commandError{exitCode: 1, code: "exec_error", message: "could not execute requested command"}
	}
	return nil
}

func readCredentialFromEnvironment(dependencies Dependencies, name string) ([]byte, error) {
	path := dependencies.Getenv(name)
	if path == "" {
		return nil, fmt.Errorf("%s is not set", name)
	}
	value, err := credential.ReadFile(path, credential.DefaultMaximumBytes)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return value, nil
}

func loadConfig(path string) (*config.Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open configuration: %w", err)
	}
	defer file.Close()
	cfg, err := config.Load(file)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func newFlagSet(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func usageError(err error) error {
	return &commandError{exitCode: 2, code: "usage", message: err.Error()}
}

func encodeOutput(destination io.Writer, value any, human bool) error {
	encoder := json.NewEncoder(destination)
	if human {
		encoder.SetIndent("", "  ")
	}
	if err := encoder.Encode(value); err != nil {
		return &commandError{exitCode: 1, code: "output_error", message: "could not encode output"}
	}
	return nil
}

func reportError(destination io.Writer, err error) int {
	commandErr := &commandError{exitCode: 1, code: "internal_error", message: "llm-pacer command failed"}
	if !errors.As(err, &commandErr) {
		commandErr = &commandError{exitCode: 1, code: "internal_error", message: err.Error()}
	}
	_ = json.NewEncoder(destination).Encode(map[string]any{
		"error": map[string]string{
			"code":    commandErr.code,
			"message": commandErr.message,
		},
	})
	return commandErr.exitCode
}

type commandError struct {
	exitCode int
	code     string
	message  string
}

func (err *commandError) Error() string { return err.message }

func replaceEnvironment(environment []string, name, value string) []string {
	prefix := name + "="
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, prefix) {
			result = append(result, entry)
		}
	}
	return append(result, prefix+value)
}

func execProcess(path string, arguments, environment []string) error {
	return syscall.Exec(path, arguments, environment)
}

func hasHumanFlag(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--human" {
			return true
		}
	}
	return false
}

const usageMessage = `llm-pacer <command>

Commands:
  serve --config PATH
  check-config --config PATH [--human]
  export-models --config PATH [--format openai|opencode] [--human]
  credential-write PATH
  exec-with-local-token --fd N -- COMMAND [ARG...]
  version [--human]`
