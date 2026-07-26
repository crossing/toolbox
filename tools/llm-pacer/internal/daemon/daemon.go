package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/crossing/toolbox/tools/llm-pacer/internal/config"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/httpapi"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/proxy"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/retry"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/scheduler"
	"github.com/crossing/toolbox/tools/llm-pacer/internal/upstream"
)

// Leave systemd's 30-second stop deadline enough time to observe shutdown and
// perform final process cleanup after active handlers are canceled.
const gracefulShutdownTimeout = 25 * time.Second

type Daemon struct {
	config    *config.Config
	logger    *slog.Logger
	scheduler *scheduler.Scheduler
	upstream  *upstream.Client
	server    *http.Server
	closeOnce sync.Once
}

func New(cfg *config.Config, upstreamAPIKey, localAPIKey string, logger *slog.Logger) (*Daemon, error) {
	if cfg == nil {
		return nil, errors.New("daemon configuration is required")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if upstreamAPIKey == "" || localAPIKey == "" {
		return nil, errors.New("daemon credentials must be non-empty")
	}
	if logger == nil {
		return nil, errors.New("daemon logger is required")
	}

	scheduled, err := scheduler.New(scheduler.Config{
		RequestsPerMinute:    cfg.RPM,
		MinRequestsPerMinute: cfg.MinAdaptiveRPM,
		MaxInflightAttempts:  cfg.MaxInflight,
		MaxAdmittedRequests:  cfg.QueueLimit,
		MaxRetainedBodyBytes: cfg.MaxQueuedBodyBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("create scheduler: %w", err)
	}

	upstreamClient, err := upstream.NewClient(upstream.Config{
		BaseURL:               cfg.UpstreamBaseURL,
		BearerToken:           upstreamAPIKey,
		ConnectTimeout:        cfg.ConnectTimeout.Duration(),
		ResponseHeaderTimeout: cfg.UpstreamRequestTimeout.Duration(),
		StreamIdleTimeout:     cfg.StreamIdleTimeout.Duration(),
		MaxInflight:           cfg.MaxInflight,
	})
	if err != nil {
		_ = scheduled.Close()
		return nil, fmt.Errorf("create upstream client: %w", err)
	}

	retryPolicy, err := retry.New(retry.Config{
		MaxRetries: cfg.MaxRetries,
		BaseDelay:  time.Second,
		MaxDelay:   cfg.MaxBackoff.Duration(),
	})
	if err != nil {
		upstreamClient.CloseIdleConnections()
		_ = scheduled.Close()
		return nil, fmt.Errorf("create retry policy: %w", err)
	}

	inference, err := proxy.New(proxy.Config{
		Catalog:             cfg.Catalog,
		Scheduler:           scheduled,
		Upstream:            upstreamClient,
		RetryPolicy:         retryPolicy,
		MaxRequestBodyBytes: cfg.MaxRequestBodyBytes,
		Logger:              logger,
	})
	if err != nil {
		upstreamClient.CloseIdleConnections()
		_ = scheduled.Close()
		return nil, fmt.Errorf("create inference proxy: %w", err)
	}

	handler := httpapi.New(cfg.Catalog, localAPIKey, schedulerHealth{scheduler: scheduled}, inference)
	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           handler,
		ReadHeaderTimeout: cfg.ConnectTimeout.Duration(),
		ReadTimeout:       0,
		WriteTimeout:      0,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	return &Daemon{
		config:    cfg,
		logger:    logger,
		scheduler: scheduled,
		upstream:  upstreamClient,
		server:    server,
	}, nil
}

func (daemon *Daemon) Handler() http.Handler { return daemon.server.Handler }

func (daemon *Daemon) Serve(ctx context.Context) error {
	if ctx == nil {
		return errors.New("daemon context is required")
	}
	listener, err := net.Listen("tcp", daemon.config.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer listener.Close()

	daemon.logger.Info("llm-pacer listening",
		"listen", daemon.config.ListenAddress,
		"configured_rpm", daemon.config.RPM,
		"max_inflight", daemon.config.MaxInflight,
		"queue_limit", daemon.config.QueueLimit,
		"models", len(daemon.config.Models),
	)

	serveResult := make(chan error, 1)
	go func() {
		serveResult <- daemon.server.Serve(listener)
	}()

	select {
	case err := <-serveResult:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), gracefulShutdownTimeout)
		defer cancel()
		if err := daemon.server.Shutdown(shutdownContext); err != nil {
			_ = daemon.server.Close()
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		if err := <-serveResult; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve during shutdown: %w", err)
		}
		return nil
	}
}

func (daemon *Daemon) Close() {
	if daemon == nil {
		return
	}
	daemon.closeOnce.Do(func() {
		_ = daemon.server.Close()
		daemon.upstream.CloseIdleConnections()
		_ = daemon.scheduler.Close()
	})
}

type schedulerHealth struct {
	scheduler *scheduler.Scheduler
}

func (health schedulerHealth) Snapshot() httpapi.Snapshot {
	snapshot := health.scheduler.Snapshot()
	return httpapi.Snapshot{
		OK:             true,
		ConfiguredRPM:  snapshot.ConfiguredRPM,
		EffectiveRPM:   snapshot.EffectiveRPM,
		MaxInflight:    snapshot.MaxInflightAttempts,
		Active:         snapshot.ActiveAttempts,
		Queued:         snapshot.QueuedAttempts,
		BackingOff:     snapshot.BackingOff,
		Admitted:       snapshot.AdmittedRequests,
		QueueLimit:     snapshot.RequestCountLimit,
		QueuedBytes:    snapshot.RetainedBodyBytes,
		MaxQueuedBytes: snapshot.RetainedBytesLimit,
	}
}
