package rpc

import (
	"context"
	"encoding/json"
	"fmt"

	bare "github.com/holepunchto/bare-rpc-golang"
	c "github.com/holepunchto/compact-encoding-golang"
	"github.com/sipeed/picoclaw/pkg/providers"
)

// handleStateExport serialises every session in the default agent's store
// into a compact-encoded array of SessionBlobs.
func (s *Server) handleStateExport(_ context.Context, req *bare.Request) {
	agent := s.loop.GetRegistry().GetDefaultAgent()
	if agent == nil {
		_ = req.ReplyError(fmt.Errorf("no default agent"))
		return
	}

	keys := agent.Sessions.ListSessions()
	blobs := make([]SessionBlob, 0, len(keys))
	for _, key := range keys {
		payload, err := marshalSessionPayload(agent.Sessions.GetHistory(key), agent.Sessions.GetSummary(key))
		if err != nil {
			_ = req.ReplyError(fmt.Errorf("marshal session %s: %w", key, err))
			return
		}
		blobs = append(blobs, SessionBlob{Key: key, Data: payload})
	}

	data, err := encodeBlobArray(blobs)
	if err != nil {
		_ = req.ReplyError(err)
		return
	}
	_ = req.Reply(data)
}

// handleStateImport restores all sessions from a compact-encoded blob array.
func (s *Server) handleStateImport(_ context.Context, req *bare.Request) {
	blobs, err := decodeBlobArray(req.Data)
	if err != nil {
		_ = req.ReplyError(fmt.Errorf("bad StateBlob: %w", err))
		return
	}

	agent := s.loop.GetRegistry().GetDefaultAgent()
	if agent == nil {
		_ = req.ReplyError(fmt.Errorf("no default agent"))
		return
	}

	for _, blob := range blobs {
		history, summary, err := unmarshalSessionPayload(blob.Data)
		if err != nil {
			_ = req.ReplyError(fmt.Errorf("session %s: %w", blob.Key, err))
			return
		}
		agent.Sessions.SetHistory(blob.Key, history)
		agent.Sessions.SetSummary(blob.Key, summary)
		if err := agent.Sessions.Save(blob.Key); err != nil {
			_ = req.ReplyError(fmt.Errorf("save %s: %w", blob.Key, err))
			return
		}
	}

	_ = req.Reply(nil)
}

// notifyStateChanged fires a CmdStateChanged event to the JS side after a
// session's history or summary changes. Called by the notifyingStore wrapper
// (not yet wired — future work).
func (s *Server) notifyStateChanged(sessionKey string, field uint8, data []byte) {
	chunk := StateChunk{SessionKey: sessionKey, Field: field, Data: data}
	payload, err := c.Marshal(&chunk)
	if err != nil {
		return
	}
	_ = s.rpc.Event(CmdStateChanged, payload)
}

// sessionDump is the JSON envelope inside each SessionBlob.Data.
// History and summary are stored as JSON because providers.Message is a rich
// struct not yet covered by compact-encoding codecs.
type sessionDump struct {
	History []json.RawMessage `json:"h"`
	Summary string            `json:"s,omitempty"`
}

func marshalSessionPayload(history []providers.Message, summary string) ([]byte, error) {
	rawHistory := make([]json.RawMessage, len(history))
	for i, msg := range history {
		b, err := json.Marshal(msg)
		if err != nil {
			return nil, err
		}
		rawHistory[i] = b
	}
	return json.Marshal(sessionDump{History: rawHistory, Summary: summary})
}

func unmarshalSessionPayload(data []byte) ([]providers.Message, string, error) {
	var dump sessionDump
	if err := json.Unmarshal(data, &dump); err != nil {
		return nil, "", err
	}
	history, err := decodeHistory(dump.History)
	if err != nil {
		return nil, "", err
	}
	return history, dump.Summary, nil
}

// encodeBlobArray packs []SessionBlob as: varuint(count) + [blob0, blob1, ...].
// Each blob is compact-encoded by EncodeInto so the whole array is a flat
// self-describing byte stream that decodeBlobArray can walk with DecodeFrom.
func encodeBlobArray(blobs []SessionBlob) ([]byte, error) {
	state := c.NewState()
	c.NewUint().Preencode(state, uint(len(blobs)))
	for i := range blobs {
		if err := c.PreencodeInto(state, &blobs[i]); err != nil {
			return nil, err
		}
	}
	state.Allocate()
	if err := c.NewUint().Encode(state, uint(len(blobs))); err != nil {
		return nil, err
	}
	for i := range blobs {
		if err := c.EncodeInto(state, &blobs[i]); err != nil {
			return nil, err
		}
	}
	return state.Buffer, nil
}

func decodeBlobArray(data []byte) ([]SessionBlob, error) {
	state := c.NewState()
	state.Buffer = data
	state.End = uint(len(data))

	n, err := c.NewUint().Decode(state)
	if err != nil {
		return nil, err
	}
	blobs := make([]SessionBlob, n)
	for i := range blobs {
		if err := c.DecodeFrom(state, &blobs[i]); err != nil {
			return nil, err
		}
	}
	return blobs, nil
}
