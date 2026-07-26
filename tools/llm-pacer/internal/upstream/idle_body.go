package upstream

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

// ErrResponseBodyIdleTimeout is returned when one response-body Read remains
// blocked without upstream data for the configured stream idle timeout.
var ErrResponseBodyIdleTimeout = errors.New("upstream response body idle timeout")

type idleReadCloser struct {
	ctx  context.Context
	body io.ReadCloser
	idle time.Duration

	done     chan struct{}
	doneOnce sync.Once

	closeOnce sync.Once
	closeErr  error

	causeMu sync.RWMutex
	cause   error
}

func newIdleReadCloser(ctx context.Context, body io.ReadCloser, idle time.Duration) io.ReadCloser {
	wrapped := &idleReadCloser{
		ctx:  ctx,
		body: body,
		idle: idle,
		done: make(chan struct{}),
	}
	go wrapped.watchContext()
	return wrapped
}

func (body *idleReadCloser) watchContext() {
	select {
	case <-body.ctx.Done():
		body.abort(body.ctx.Err())
	case <-body.done:
	}
}

func (body *idleReadCloser) Read(p []byte) (int, error) {
	timerFinished := make(chan struct{})
	timer := time.AfterFunc(body.idle, func() {
		body.abort(ErrResponseBodyIdleTimeout)
		close(timerFinished)
	})

	n, err := body.body.Read(p)
	if !timer.Stop() {
		<-timerFinished
	}

	if cause := body.abortCause(); cause != nil {
		return n, cause
	}
	if err != nil {
		if contextErr := body.ctx.Err(); contextErr != nil {
			body.abort(contextErr)
			return n, contextErr
		}
		body.stopWatching()
	}
	return n, err
}

func (body *idleReadCloser) Close() error {
	body.stopWatching()
	return body.closeUnderlying()
}

func (body *idleReadCloser) abort(cause error) {
	body.causeMu.Lock()
	if body.cause == nil {
		body.cause = cause
	}
	body.causeMu.Unlock()
	_ = body.closeUnderlying()
	body.stopWatching()
}

func (body *idleReadCloser) abortCause() error {
	body.causeMu.RLock()
	defer body.causeMu.RUnlock()
	return body.cause
}

func (body *idleReadCloser) closeUnderlying() error {
	body.closeOnce.Do(func() {
		body.closeErr = body.body.Close()
	})
	return body.closeErr
}

func (body *idleReadCloser) stopWatching() {
	body.doneOnce.Do(func() {
		close(body.done)
	})
}
