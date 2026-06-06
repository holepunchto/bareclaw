package rpc

import (
	"encoding/json"

	"github.com/sipeed/picoclaw/pkg/providers"
)

// toAny converts a []providers.Message to []interface{} for JSON encoding.
func toAny(msgs []providers.Message) []interface{} {
	out := make([]interface{}, len(msgs))
	for i, m := range msgs {
		out[i] = m
	}
	return out
}

// decodeHistory round-trips []json.RawMessage back into []providers.Message.
func decodeHistory(raw []json.RawMessage) ([]providers.Message, error) {
	msgs := make([]providers.Message, 0, len(raw))
	for _, r := range raw {
		var msg providers.Message
		if err := json.Unmarshal(r, &msg); err != nil {
			return nil, err
		}
		msgs = append(msgs, msg)
	}
	return msgs, nil
}
