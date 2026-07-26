package opencode_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/catalog"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/config"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/daemon"
)

const (
	requiredOpenCodeVersion = "1.18.5"
	localTestKey            = "local-test-key"
	upstreamTestKey         = "upstream-test-key"
	mockModelID             = "acme/mock-model"
	alphaModelID            = "acme/alpha-model"
	blockingPrompt          = "BLOCK_ACTIVE_REQUEST"
	silentQueueHold         = 2500 * time.Millisecond
)

type commandResult struct {
	stdout string
	stderr string
}

type commandExit struct {
	result commandResult
	err    error
}

type runningCommand struct {
	label   string
	ctx     context.Context
	cancel  context.CancelFunc
	timeout time.Duration
	done    <-chan commandExit
}

type headerSignalWriter struct {
	http.ResponseWriter
	done chan struct{}
}

func (w *headerSignalWriter) signal() {
	select {
	case w.done <- struct{}{}:
	default:
	}
}

func (w *headerSignalWriter) WriteHeader(statusCode int) {
	w.signal()
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *headerSignalWriter) Write(body []byte) (int, error) {
	w.signal()
	return w.ResponseWriter.Write(body)
}

func (w *headerSignalWriter) Flush() {
	w.signal()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

type requestObservations struct {
	mu sync.Mutex

	modelAuthorizations []string
	chatAuthorizations  []string
	upstreamAuth        []string
	requestedModels     []string
	promptSeen          bool
}

type requestSnapshot struct {
	modelAuthorizations []string
	chatAuthorizations  []string
	upstreamAuth        []string
	requestedModels     []string
	promptSeen          bool
}

func (o *requestObservations) recordModels(authorization string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.modelAuthorizations = append(o.modelAuthorizations, authorization)
}

func (o *requestObservations) recordLocalChat(authorization string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.chatAuthorizations = append(o.chatAuthorizations, authorization)
}

func (o *requestObservations) recordUpstream(authorization, model string, promptSeen bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.upstreamAuth = append(o.upstreamAuth, authorization)
	o.requestedModels = append(o.requestedModels, model)
	o.promptSeen = o.promptSeen || promptSeen
}

func (o *requestObservations) snapshot() requestSnapshot {
	o.mu.Lock()
	defer o.mu.Unlock()
	return requestSnapshot{
		modelAuthorizations: append([]string(nil), o.modelAuthorizations...),
		chatAuthorizations:  append([]string(nil), o.chatAuthorizations...),
		upstreamAuth:        append([]string(nil), o.upstreamAuth...),
		requestedModels:     append([]string(nil), o.requestedModels...),
		promptSeen:          o.promptSeen,
	}
}

func TestOpenCodeProviderAcceptance(t *testing.T) {
	openCodeBinary := os.Getenv("OPENCODE_BIN")
	if openCodeBinary == "" {
		t.Skip("set OPENCODE_BIN to opt in to the OpenCode 1.18.5 acceptance test")
	}

	version := runVersion(t, openCodeBinary)
	if version != requiredOpenCodeVersion {
		t.Fatalf("opencode --version = %q, require %s", version, requiredOpenCodeVersion)
	}

	observed := &requestObservations{}
	blockerEntered := make(chan struct{}, 1)
	releaseBlocker := make(chan struct{})
	var releaseBlockerOnce sync.Once
	release := func() {
		releaseBlockerOnce.Do(func() { close(releaseBlocker) })
	}
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		observed.recordUpstream(
			request.Header.Get("Authorization"),
			payload.Model,
			bytes.Contains(body, []byte("Reply exactly MOCK_OK")),
		)
		if bytes.Contains(body, []byte(blockingPrompt)) {
			select {
			case blockerEntered <- struct{}{}:
			default:
			}
			select {
			case <-releaseBlocker:
			case <-request.Context().Done():
				return
			}
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		chunks := []string{
			`{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"acme/mock-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"acme/mock-model","choices":[{"index":0,"delta":{"content":"MOCK_OK"},"finish_reason":null}]}`,
			`{"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"acme/mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
		}
		for _, chunk := range chunks {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", chunk)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}))
	defer upstreamServer.Close()

	cfg := acceptanceConfig(upstreamServer.URL)
	daemonLogger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	proxyDaemon, err := daemon.New(cfg, upstreamTestKey, localTestKey, daemonLogger)
	if err != nil {
		t.Fatalf("daemon.New() error = %v", err)
	}
	defer proxyDaemon.Close()

	var discoveryUnavailable atomic.Bool
	var failedDiscoveries atomic.Int64
	queuedChatSeen := make(chan struct{}, 1)
	queuedResponseHeaders := make(chan struct{}, 1)
	var queuedChatOnce sync.Once
	daemonHandler := proxyDaemon.Handler()
	localServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/models":
			observed.recordModels(request.Header.Get("Authorization"))
			if discoveryUnavailable.Load() {
				failedDiscoveries.Add(1)
				http.Error(w, "mock discovery unavailable", http.StatusServiceUnavailable)
				return
			}
		case "/v1/chat/completions":
			observed.recordLocalChat(request.Header.Get("Authorization"))
			if request.Header.Get("X-LLM-Pacer-Test-Role") != "blocker" {
				queuedChatOnce.Do(func() { queuedChatSeen <- struct{}{} })
				daemonHandler.ServeHTTP(&headerSignalWriter{
					ResponseWriter: w,
					done:           queuedResponseHeaders,
				}, request)
				return
			}
		}
		daemonHandler.ServeHTTP(w, request)
	}))
	defer localServer.Close()
	defer release()

	root := t.TempDir()
	environment, renderedPlugin := prepareIsolatedConfig(t, root, localServer.URL+"/v1", cfg.Models)
	if bytes.Contains(renderedPlugin, []byte(localTestKey)) {
		t.Fatal("rendered plugin contains the local test token")
	}

	models := runOpenCode(t, openCodeBinary, environment, filepath.Join(root, "home"), 20*time.Second,
		"models", "llm-pacer",
	)
	modelLines := nonEmptyLines(models.stdout)
	wantModels := []string{"llm-pacer/" + alphaModelID, "llm-pacer/" + mockModelID}
	if len(modelLines) != len(wantModels) {
		t.Fatalf("opencode models listed %d entries, want %d: %q", len(modelLines), len(wantModels), modelLines)
	}
	for index, want := range wantModels {
		if modelLines[index] != want {
			t.Fatalf("opencode models line %d = %q, want %q", index, modelLines[index], want)
		}
	}

	blockerDone := startBlockingRequest(t, localServer.URL)
	waitForSignal(t, blockerEntered, 5*time.Second, "blocking request to occupy the active upstream slot")

	queuedRun := startOpenCode(t, openCodeBinary, environment, filepath.Join(root, "home"), 30*time.Second,
		"run", "--model", "llm-pacer/acme/mock-model", "--format", "json", "Reply exactly MOCK_OK",
	)
	defer queuedRun.cancel()
	waitForSignal(t, queuedChatSeen, 10*time.Second, "OpenCode chat request to reach llm-pacer")
	waitForQueuedHealth(t, localServer.URL, 5*time.Second)

	queuedAt := time.Now()
	timer := time.NewTimer(silentQueueHold)
	defer timer.Stop()
	select {
	case exit := <-queuedRun.done:
		result := checkOpenCodeExit(t, queuedRun, exit)
		t.Fatalf("opencode run exited while its request was still queued\nstdout: %s\nstderr: %s", result.stdout, result.stderr)
	case <-queuedResponseHeaders:
		t.Fatal("llm-pacer sent response headers while the OpenCode request was still queued")
	case <-timer.C:
	}
	if waited := time.Since(queuedAt); waited < silentQueueHold {
		t.Fatalf("silent queued wait = %s, want at least %s", waited, silentQueueHold)
	}
	select {
	case <-queuedResponseHeaders:
		t.Fatal("llm-pacer sent response headers before the active request was released")
	case exit := <-queuedRun.done:
		result := checkOpenCodeExit(t, queuedRun, exit)
		t.Fatalf("opencode run exited before the active request was released\nstdout: %s\nstderr: %s", result.stdout, result.stderr)
	default:
	}

	release()
	waitForRequest(t, blockerDone, 5*time.Second, "blocking request completion")
	run := finishOpenCode(t, queuedRun)
	assertTextCompletion(t, run.stdout, "MOCK_OK")

	discoveryUnavailable.Store(true)
	debug := runOpenCode(t, openCodeBinary, environment, filepath.Join(root, "home"), 20*time.Second,
		"debug", "config",
	)
	if failedDiscoveries.Load() == 0 {
		t.Fatal("debug config did not exercise unavailable live discovery")
	}
	for _, model := range []string{alphaModelID, mockModelID} {
		if !strings.Contains(debug.stdout, model) {
			t.Fatalf("debug config static fallback omitted model %q", model)
		}
	}
	if !strings.Contains(debug.stderr, "using the static catalogue") {
		t.Fatalf("debug config did not report static fallback: %q", debug.stderr)
	}
	assertDebugTimeoutsDisabled(t, debug.stdout)

	assertAuthenticatedRequests(t, observed.snapshot())
}

func acceptanceConfig(upstreamURL string) *config.Config {
	cfg := config.Defaults()
	cfg.UpstreamBaseURL = upstreamURL
	cfg.RPM = 60_000
	cfg.MinAdaptiveRPM = 1
	cfg.MaxInflight = 1
	cfg.QueueLimit = 8
	cfg.MaxQueuedBodyBytes = 1 << 20
	cfg.MaxRequestBodyBytes = 1 << 18
	cfg.MaxRetries = 1
	cfg.MaxBackoff = config.NewDuration(time.Second)
	cfg.UpstreamRequestTimeout = config.NewDuration(10 * time.Second)
	cfg.StreamIdleTimeout = config.NewDuration(10 * time.Second)
	cfg.ConnectTimeout = config.NewDuration(2 * time.Second)
	cfg.Models = map[string]catalog.Model{
		mockModelID: {
			Name:   "Mock Model",
			Owner:  "acceptance",
			Limits: catalog.Limits{Context: 4096, Output: 512},
			Modalities: catalog.Modalities{
				Input:  []string{"text"},
				Output: []string{"text"},
			},
		},
		alphaModelID: {
			Name:   "Alpha Model",
			Owner:  "acceptance",
			Limits: catalog.Limits{Context: 2048, Output: 256},
			Modalities: catalog.Modalities{
				Input:  []string{"text"},
				Output: []string{"text"},
			},
		},
	}
	return &cfg
}

func startBlockingRequest(t *testing.T, baseURL string) <-chan error {
	t.Helper()
	body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":%q}],"stream":true}`, mockModelID, blockingPrompt)
	request, err := http.NewRequest(http.MethodPost, baseURL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatalf("create blocking request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+localTestKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-LLM-Pacer-Test-Role", "blocker")

	transport := &http.Transport{Proxy: nil}
	client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
	done := make(chan error, 1)
	go func() {
		defer transport.CloseIdleConnections()
		response, requestErr := client.Do(request)
		if requestErr != nil {
			done <- requestErr
			return
		}
		defer response.Body.Close()
		_, copyErr := io.Copy(io.Discard, response.Body)
		if copyErr != nil {
			done <- copyErr
			return
		}
		if response.StatusCode != http.StatusOK {
			done <- fmt.Errorf("status = %d, want %d", response.StatusCode, http.StatusOK)
			return
		}
		done <- nil
	}()
	return done
}

func waitForSignal(t *testing.T, signal <-chan struct{}, timeout time.Duration, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitForRequest(t *testing.T, done <-chan error, timeout time.Duration, description string) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("%s failed: %v", description, err)
		}
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitForQueuedHealth(t *testing.T, baseURL string, timeout time.Duration) {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: time.Second}
	defer client.Transport.(*http.Transport).CloseIdleConnections()
	deadline := time.Now().Add(timeout)
	var last configHealth
	var lastErr error
	for time.Now().Before(deadline) {
		response, err := client.Get(baseURL + "/healthz")
		if err == nil {
			decodeErr := json.NewDecoder(response.Body).Decode(&last)
			closeErr := response.Body.Close()
			if decodeErr == nil && closeErr == nil && last.Active == 1 && last.Queued >= 1 {
				return
			}
			if decodeErr != nil {
				lastErr = decodeErr
			} else {
				lastErr = closeErr
			}
		} else {
			lastErr = err
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("proxy never reported active=1 with queued>=1; last health=%+v error=%v", last, lastErr)
}

type configHealth struct {
	Active int `json:"active"`
	Queued int `json:"queued"`
}

func prepareIsolatedConfig(t *testing.T, root, baseURL string, models map[string]catalog.Model) ([]string, []byte) {
	t.Helper()
	home := filepath.Join(root, "home")
	xdgConfig := filepath.Join(root, "config")
	globalConfig := filepath.Join(xdgConfig, "opencode")
	configDir := filepath.Join(root, "opencode-config")
	pluginDir := filepath.Join(configDir, "plugins")
	dataDir := filepath.Join(root, "data")
	stateDir := filepath.Join(root, "state")
	cacheDir := filepath.Join(root, "cache")
	for _, directory := range []string{home, globalConfig, pluginDir, dataDir, stateDir, cacheDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatalf("create isolated directory: %v", err)
		}
	}

	source, err := os.ReadFile(filepath.Join("..", "..", "opencode-plugin.js"))
	if err != nil {
		t.Fatalf("read opencode-plugin.js: %v", err)
	}
	baseJSON, err := json.Marshal(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	modelsJSON, err := json.Marshal(models)
	if err != nil {
		t.Fatal(err)
	}
	rendered := bytes.ReplaceAll(source, []byte("__LLM_PACER_BASE_URL__"), baseJSON)
	rendered = bytes.ReplaceAll(rendered, []byte("__LLM_PACER_STATIC_CATALOG__"), modelsJSON)
	if bytes.Contains(rendered, []byte("__LLM_PACER_")) {
		t.Fatal("rendered OpenCode plugin retains a template placeholder")
	}
	pluginPath := filepath.Join(pluginDir, "llm-pacer.js")
	if err := os.WriteFile(pluginPath, rendered, 0o600); err != nil {
		t.Fatalf("write rendered OpenCode plugin: %v", err)
	}

	// OpenCode checks writability before attempting its background plugin
	// dependency setup. Read-only config roots make that check return early,
	// keeping this acceptance test offline and immutable.
	t.Cleanup(func() {
		for _, tree := range []string{xdgConfig, configDir} {
			makeWritable(t, tree)
		}
	})
	for _, tree := range []string{xdgConfig, configDir} {
		makeReadOnly(t, tree)
	}

	path := os.Getenv("PATH")
	return []string{
		"PATH=" + path,
		"LANG=C.UTF-8",
		"HOME=" + home,
		"OPENCODE_TEST_HOME=" + home,
		"XDG_CONFIG_HOME=" + xdgConfig,
		"XDG_DATA_HOME=" + dataDir,
		"XDG_STATE_HOME=" + stateDir,
		"XDG_CACHE_HOME=" + cacheDir,
		"OPENCODE_CONFIG_DIR=" + configDir,
		"OPENCODE_DISABLE_PROJECT_CONFIG=1",
		"OPENCODE_DISABLE_MODELS_FETCH=1",
		"OPENCODE_DISABLE_AUTOUPDATE=1",
		"OPENCODE_DISABLE_AUTOCOMPACT=1",
		"OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
		"OPENCODE_DISABLE_LSP_DOWNLOAD=1",
		"OPENCODE_DISABLE_CLAUDE_CODE=1",
		"OPENCODE_AUTH_CONTENT={}",
		"OPENCODE_DB=:memory:",
		"LLM_PACER_API_KEY=" + localTestKey,
	}, rendered
}

func makeReadOnly(t *testing.T, root string) {
	t.Helper()
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return os.Chmod(path, 0o500)
		}
		return os.Chmod(path, 0o400)
	}); err != nil {
		t.Fatalf("make config tree read-only: %v", err)
	}
}

func makeWritable(t *testing.T, root string) {
	t.Helper()
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return os.Chmod(path, 0o700)
		}
		return os.Chmod(path, 0o600)
	}); err != nil {
		t.Errorf("restore config tree permissions: %v", err)
	}
}

func runVersion(t *testing.T, binary string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "--version")
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C.UTF-8"}
	command.WaitDelay = time.Second
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatal("opencode --version timed out")
	}
	if err != nil {
		t.Fatalf("opencode --version failed: %v", err)
	}
	return strings.TrimSpace(string(output))
}

func runOpenCode(t *testing.T, binary string, environment []string, directory string, timeout time.Duration, arguments ...string) commandResult {
	t.Helper()
	return finishOpenCode(t, startOpenCode(t, binary, environment, directory, timeout, arguments...))
}

func startOpenCode(t *testing.T, binary string, environment []string, directory string, timeout time.Duration, arguments ...string) *runningCommand {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	command := exec.CommandContext(ctx, binary, arguments...)
	command.Dir = directory
	command.Env = environment
	command.WaitDelay = 2 * time.Second
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		cancel()
		t.Fatalf("start opencode %s: %v", strings.Join(arguments, " "), err)
	}
	done := make(chan commandExit, 1)
	go func() {
		err := command.Wait()
		done <- commandExit{
			result: commandResult{stdout: stdout.String(), stderr: stderr.String()},
			err:    err,
		}
		close(done)
	}()
	return &runningCommand{
		label:   strings.Join(arguments, " "),
		ctx:     ctx,
		cancel:  cancel,
		timeout: timeout,
		done:    done,
	}
}

func finishOpenCode(t *testing.T, running *runningCommand) commandResult {
	t.Helper()
	return checkOpenCodeExit(t, running, <-running.done)
}

func checkOpenCodeExit(t *testing.T, running *runningCommand, exit commandExit) commandResult {
	t.Helper()
	contextErr := running.ctx.Err()
	running.cancel()
	assertNoLocalToken(t, running.label, exit.result)
	if contextErr != nil {
		t.Fatalf("opencode %s timed out after %s", running.label, running.timeout)
	}
	if exit.err != nil {
		t.Fatalf("opencode %s failed: %v\nstdout: %s\nstderr: %s", running.label, exit.err, exit.result.stdout, exit.result.stderr)
	}
	return exit.result
}

func assertNoLocalToken(t *testing.T, command string, result commandResult) {
	t.Helper()
	if strings.Contains(result.stdout, localTestKey) || strings.Contains(result.stderr, localTestKey) {
		t.Fatalf("opencode %s exposed the local test token", command)
	}
}

func nonEmptyLines(value string) []string {
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

func assertTextCompletion(t *testing.T, output, want string) {
	t.Helper()
	found := false
	for index, line := range nonEmptyLines(output) {
		var event struct {
			Type string `json:"type"`
			Part struct {
				Text string `json:"text"`
			} `json:"part"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("run output line %d is not JSON: %v", index+1, err)
		}
		if event.Type == "text" && event.Part.Text == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("run output did not contain exact text completion %q", want)
	}
}

func assertDebugTimeoutsDisabled(t *testing.T, output string) {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(output), &document); err != nil {
		t.Logf("debug config is not a single JSON document; cannot inspect provider timeouts: %v", err)
		return
	}
	providers, ok := document["provider"].(map[string]any)
	if !ok {
		t.Log("debug config omitted provider details; cannot inspect provider timeouts")
		return
	}
	provider, ok := providers["llm-pacer"].(map[string]any)
	if !ok {
		t.Log("debug config omitted llm-pacer provider details; cannot inspect provider timeouts")
		return
	}
	options, ok := provider["options"].(map[string]any)
	if !ok {
		t.Log("debug config omitted llm-pacer provider options; cannot inspect provider timeouts")
		return
	}
	inspected := 0
	for _, name := range []string{"headerTimeout", "timeout"} {
		value, present := options[name]
		if !present {
			continue
		}
		inspected++
		disabled, isBoolean := value.(bool)
		if !isBoolean || disabled {
			t.Fatalf("debug config llm-pacer option %s = %#v, want false", name, value)
		}
	}
	if inspected == 0 {
		t.Log("debug config omitted timeout option values; cannot inspect provider timeouts")
	}
}

func assertAuthenticatedRequests(t *testing.T, observed requestSnapshot) {
	t.Helper()
	if len(observed.modelAuthorizations) < 3 {
		t.Fatalf("model discovery requests = %d, want at least one per command", len(observed.modelAuthorizations))
	}
	for _, authorization := range observed.modelAuthorizations {
		if authorization != "Bearer "+localTestKey {
			t.Fatalf("model discovery authorization = %q", authorization)
		}
	}
	if len(observed.chatAuthorizations) == 0 {
		t.Fatal("OpenCode made no authenticated local chat request")
	}
	for _, authorization := range observed.chatAuthorizations {
		if authorization != "Bearer "+localTestKey {
			t.Fatalf("local chat authorization = %q", authorization)
		}
	}
	if len(observed.upstreamAuth) != len(observed.chatAuthorizations) {
		t.Fatalf("local chat requests = %d, upstream chat requests = %d", len(observed.chatAuthorizations), len(observed.upstreamAuth))
	}
	for _, authorization := range observed.upstreamAuth {
		if authorization != "Bearer "+upstreamTestKey {
			t.Fatal("upstream authorization was not replaced")
		}
	}
	for _, model := range observed.requestedModels {
		if model != mockModelID {
			t.Fatalf("upstream requested model = %q, want %q", model, mockModelID)
		}
	}
	if !observed.promptSeen {
		t.Fatal("upstream did not receive the exact OpenCode acceptance prompt")
	}
}
