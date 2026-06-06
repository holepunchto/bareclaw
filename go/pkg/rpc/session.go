package rpc

import (
	"context"
	"encoding/json"
	"fmt"

	bare "github.com/holepunchto/bare-rpc-golang"
	c "github.com/holepunchto/compact-encoding-golang"
	"github.com/sipeed/picoclaw/pkg/session"
)

func (s *Server) handleSessionCreate(_ context.Context, req *bare.Request) {
	var scope SessionScope
	if err := c.Unmarshal(req.Data, &scope); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad SessionScope: %w", err))
		return
	}

	key := session.BuildSessionKey(session.SessionScope{
		AgentID: scope.AgentID,
		Channel: scope.Channel,
		Account: scope.Account,
		Values:  map[string]string{"peer": scope.Peer},
	})

	data, err := c.Marshal(&SessionKey{Key: key})
	if err != nil {
		_ = req.ReplyError(err)
		return
	}
	_ = req.Reply(data)
}

func (s *Server) handleSessionList(_ context.Context, req *bare.Request) {
	agent := s.loop.GetRegistry().GetDefaultAgent()
	if agent == nil {
		_ = req.ReplyError(fmt.Errorf("no default agent"))
		return
	}

	keys := agent.Sessions.ListSessions()
	// Encode as a compact array of SessionKey structs.
	type sessionList struct {
		Keys []string
	}
	data, err := c.Marshal(&sessionList{Keys: keys})
	if err != nil {
		_ = req.ReplyError(err)
		return
	}
	_ = req.Reply(data)
}

func (s *Server) handleSessionExport(_ context.Context, req *bare.Request) {
	var sk SessionKey
	if err := c.Unmarshal(req.Data, &sk); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad SessionKey: %w", err))
		return
	}

	agent := s.loop.GetRegistry().GetDefaultAgent()
	if agent == nil {
		_ = req.ReplyError(fmt.Errorf("no default agent"))
		return
	}

	type sessionDump struct {
		History []interface{} `json:"history"`
		Summary string        `json:"summary"`
	}

	// History entries are providers.Message — encode the history as JSON bytes
	// and wrap in a compact buffer so the JS side gets an opaque blob it can
	// store verbatim in Hyperbee.
	history := agent.Sessions.GetHistory(sk.Key)
	summary := agent.Sessions.GetSummary(sk.Key)

	payload, err := json.Marshal(sessionDump{History: toAny(history), Summary: summary})
	if err != nil {
		_ = req.ReplyError(err)
		return
	}

	blob := SessionBlob{Key: sk.Key, Data: payload}
	data, err := c.Marshal(&blob)
	if err != nil {
		_ = req.ReplyError(err)
		return
	}
	_ = req.Reply(data)
}

func (s *Server) handleSessionImport(_ context.Context, req *bare.Request) {
	var blob SessionBlob
	if err := c.Unmarshal(req.Data, &blob); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad SessionBlob: %w", err))
		return
	}

	agent := s.loop.GetRegistry().GetDefaultAgent()
	if agent == nil {
		_ = req.ReplyError(fmt.Errorf("no default agent"))
		return
	}

	type sessionDump struct {
		History []json.RawMessage `json:"history"`
		Summary string            `json:"summary"`
	}
	var dump sessionDump
	if err := json.Unmarshal(blob.Data, &dump); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad session JSON: %w", err))
		return
	}

	history, err := decodeHistory(dump.History)
	if err != nil {
		_ = req.ReplyError(fmt.Errorf("history decode: %w", err))
		return
	}

	agent.Sessions.SetHistory(blob.Key, history)
	agent.Sessions.SetSummary(blob.Key, dump.Summary)
	if err := agent.Sessions.Save(blob.Key); err != nil {
		_ = req.ReplyError(fmt.Errorf("session save: %w", err))
		return
	}

	_ = req.Reply(nil)
}
