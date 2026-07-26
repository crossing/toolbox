package credential

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

const DefaultMaximumBytes int64 = 64 * 1024

func WriteExclusive(path string, source io.Reader, maximum int64) (err error) {
	if path == "" || source == nil || maximum <= 0 {
		return errors.New("invalid credential writer input")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create credential destination: %w", err)
	}
	keep := false
	defer func() {
		if closeErr := file.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close credential destination: %w", closeErr)
			keep = false
		}
		if !keep {
			_ = os.Remove(path)
		}
	}()

	written, err := io.Copy(file, io.LimitReader(source, maximum+1))
	if err != nil {
		return fmt.Errorf("write credential: %w", err)
	}
	if written == 0 {
		return errors.New("credential input is empty")
	}
	if written > maximum {
		return errors.New("credential input exceeds maximum size")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync credential destination: %w", err)
	}
	if err := file.Chmod(0o400); err != nil {
		return fmt.Errorf("protect credential destination: %w", err)
	}
	keep = true
	return nil
}

func ReadFile(path string, maximum int64) ([]byte, error) {
	if path == "" || maximum <= 0 {
		return nil, errors.New("invalid credential file input")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open credential file: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect credential file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("credential path is not a regular file")
	}

	return Read(file, maximum)
}

func Read(source io.Reader, maximum int64) ([]byte, error) {
	if source == nil || maximum <= 0 {
		return nil, errors.New("invalid credential input")
	}
	value, err := io.ReadAll(io.LimitReader(source, maximum+1))
	if err != nil {
		return nil, fmt.Errorf("read credential: %w", err)
	}
	if len(value) == 0 {
		return nil, errors.New("credential is empty")
	}
	if int64(len(value)) > maximum {
		return nil, errors.New("credential exceeds maximum size")
	}
	if bytes.ContainsAny(value, "\r\n\x00") {
		return nil, errors.New("credential contains a forbidden control character")
	}
	return value, nil
}
