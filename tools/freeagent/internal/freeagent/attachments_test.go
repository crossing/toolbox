package freeagent

import (
	"os"
	"testing"
)

func TestCreateAttachmentFromFile(t *testing.T) {
	content := []byte("test content")
	tmpFile, err := os.CreateTemp("", "test-attachment-*.txt")
	if err != nil {
		t.Fatalf("failed to create temp file: %v", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.Write(content); err != nil {
		t.Fatalf("failed to write to temp file: %v", err)
	}
	tmpFile.Close()

	attachment, err := CreateAttachmentFromFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if attachment.FileName == "" {
		t.Error("expected file name to be set")
	}
	if attachment.ContentType != "text/plain; charset=utf-8" {
		t.Errorf("expected content type text/plain; charset=utf-8, got %s", attachment.ContentType)
	}
	if attachment.Data == "" {
		t.Error("expected data to be set")
	}
}
