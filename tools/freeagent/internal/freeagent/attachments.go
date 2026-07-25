package freeagent

import (
	"encoding/base64"
	"mime"
	"os"
	"path/filepath"
)

type Attachment struct {
	URL         string `json:"url,omitempty"`
	Data        string `json:"data,omitempty"`
	FileName    string `json:"file_name,omitempty"`
	ContentType string `json:"content_type,omitempty"`
}

func CreateAttachmentFromFile(path string) (*Attachment, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	fileName := filepath.Base(path)
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	return &Attachment{
		Data:        base64.StdEncoding.EncodeToString(data),
		FileName:    fileName,
		ContentType: contentType,
	}, nil
}
