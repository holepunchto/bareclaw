package server

import (
	"encoding/json"

	"github.com/sipeed/picoclaw/pkg/providers"
)

// sessionDump is the JSON inside a session blob; history stays JSON because providers.Message is picoclaw's type.
type sessionDump struct {
	History []json.RawMessage `json:"h"`
	Summary string            `json:"s,omitempty"`
}

func marshalSession(history []providers.Message, summary string) ([]byte, error) {
	raw := make([]json.RawMessage, len(history))
	for i, msg := range history {
		b, err := json.Marshal(msg)
		if err != nil {
			return nil, err
		}
		raw[i] = b
	}
	return json.Marshal(sessionDump{History: raw, Summary: summary})
}

func unmarshalSession(data []byte) ([]providers.Message, string, error) {
	var dump sessionDump
	if err := json.Unmarshal(data, &dump); err != nil {
		return nil, "", err
	}
	history := make([]providers.Message, 0, len(dump.History))
	for _, r := range dump.History {
		var msg providers.Message
		if err := json.Unmarshal(r, &msg); err != nil {
			return nil, "", err
		}
		history = append(history, msg)
	}
	return history, dump.Summary, nil
}
