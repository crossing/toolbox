package credential

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fakeCredential = "fake-local-token-for-tests"

func TestWriteExclusiveAndReadFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credential")
	if err := WriteExclusive(path, strings.NewReader(fakeCredential), 1024); err != nil {
		t.Fatalf("WriteExclusive() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if got := info.Mode().Perm(); got != 0o400 {
		t.Fatalf("mode = %o, want 400", got)
	}
	value, err := ReadFile(path, 1024)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(value) != fakeCredential {
		t.Fatal("credential round trip did not preserve input")
	}
	if err := WriteExclusive(path, strings.NewReader("replacement"), 1024); err == nil {
		t.Fatal("WriteExclusive() replaced an existing destination")
	}
	value, err = ReadFile(path, 1024)
	if err != nil || string(value) != fakeCredential {
		t.Fatal("existing credential changed after exclusive-write failure")
	}
}

func TestWriteExclusiveRemovesPartialOutputOnFailure(t *testing.T) {
	tests := []struct {
		name   string
		source io.Reader
		max    int64
	}{
		{name: "empty", source: strings.NewReader(""), max: 10},
		{name: "oversized", source: strings.NewReader("too-long"), max: 3},
		{name: "reader error", source: io.MultiReader(strings.NewReader("partial"), failingReader{}), max: 100},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "credential")
			if err := WriteExclusive(path, tt.source, tt.max); err == nil {
				t.Fatal("WriteExclusive() unexpectedly succeeded")
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("partial output still exists: %v", err)
			}
		})
	}
}

func TestReadFileRejectsUnsafeInputs(t *testing.T) {
	tests := []struct {
		name  string
		value string
		max   int64
	}{
		{name: "empty", value: "", max: 10},
		{name: "oversized", value: "too-long", max: 3},
		{name: "newline", value: "secret\n", max: 10},
		{name: "carriage return", value: "secret\r", max: 10},
		{name: "nul", value: "secret\x00", max: 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "credential")
			if err := os.WriteFile(path, []byte(tt.value), 0o400); err != nil {
				t.Fatalf("WriteFile() error = %v", err)
			}
			if _, err := ReadFile(path, tt.max); err == nil {
				t.Fatal("ReadFile() unexpectedly succeeded")
			}
		})
	}
}

func TestReadFileRejectsDirectory(t *testing.T) {
	if _, err := ReadFile(t.TempDir(), 1024); err == nil {
		t.Fatal("ReadFile() accepted a directory")
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("fake read failure") }
