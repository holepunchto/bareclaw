// Package server implements the generated hrpc.Server on top of a picoclaw agent loop.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"

	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/session"

	"github.com/holepunchto/bareclaw/hrpc"
	"github.com/holepunchto/bareclaw/schema"
)

// Server serves the bareclaw commands; ToolExec stays unimplemented because the JavaScript side serves it.
type Server struct {
	hrpc.UnimplementedServer

	loop        *agent.AgentLoop
	delegate    *StreamDelegate
	providerErr error
	rpc         *hrpc.HRPC
	attached    chan struct{}
	callIDs     atomic.Uint64
}

// New serves loop; providerErr, when set, is why no model is reachable and is what Chat reports.
func New(loop *agent.AgentLoop, delegate *StreamDelegate, providerErr error) *Server {
	return &Server{loop: loop, delegate: delegate, providerErr: providerErr, attached: make(chan struct{})}
}

// Attach hands the Server the channel it serves on, so it can call back into JavaScript.
func (s *Server) Attach(rpc *hrpc.HRPC) {
	s.rpc = rpc
	close(s.attached)
}

func (s *Server) client(ctx context.Context) (*hrpc.HRPC, error) {
	select {
	case <-s.attached:
		return s.rpc, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Server) Chat(ctx context.Context, req schema.BareclawChatRequest, out *hrpc.SendStream[schema.BareclawChatChunk]) error {
	if s.providerErr != nil {
		return out.Send(schema.BareclawChatChunk{Type: schema.BareclawChunkTypeError, Content: "no model: " + s.providerErr.Error()})
	}

	chatID := fmt.Sprintf("rpc-%d", s.callIDs.Add(1))
	streamer := newStreamer(out)
	s.delegate.register("rpc", chatID, streamer)
	defer s.delegate.unregister("rpc", chatID)

	response, err := s.turn(ctx, req, chatID)
	if err != nil {
		return out.Send(schema.BareclawChatChunk{Type: schema.BareclawChunkTypeError, Content: err.Error()})
	}
	// A provider that never streamed still delivers its text exactly once.
	if !streamer.published {
		if err := out.Send(schema.BareclawChatChunk{Type: schema.BareclawChunkTypeContent, Content: response}); err != nil {
			return err
		}
	}
	return out.Send(schema.BareclawChatChunk{Type: schema.BareclawChunkTypeDone})
}

// turn runs one agent turn, turning a panic inside the agent into an error so one bad turn cannot take the process down.
func (s *Server) turn(ctx context.Context, req schema.BareclawChatRequest, chatID string) (response string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("agent panic: %v", r)
		}
	}()
	return s.loop.ProcessDirectWithChannel(ctx, req.Message, req.SessionId, "rpc", chatID)
}

func (s *Server) SessionCreate(_ context.Context, scope schema.BareclawSessionScope) (schema.BareclawSessionKey, error) {
	key := session.BuildSessionKey(session.SessionScope{
		AgentID: scope.AgentId,
		Channel: scope.Channel,
		Account: scope.Account,
		Values:  map[string]string{"peer": scope.Peer},
	})
	return schema.BareclawSessionKey{Key: key}, nil
}

func (s *Server) SessionList(context.Context, schema.BareclawEmpty) (schema.BareclawSessionList, error) {
	a, err := s.agent()
	if err != nil {
		return schema.BareclawSessionList{}, err
	}
	return schema.BareclawSessionList{Keys: a.Sessions.ListSessions()}, nil
}

func (s *Server) SessionExport(_ context.Context, req schema.BareclawSessionKey) (schema.BareclawSessionBlob, error) {
	a, err := s.agent()
	if err != nil {
		return schema.BareclawSessionBlob{}, err
	}
	data, err := marshalSession(a.Sessions.GetHistory(req.Key), a.Sessions.GetSummary(req.Key))
	if err != nil {
		return schema.BareclawSessionBlob{}, err
	}
	return schema.BareclawSessionBlob{Key: req.Key, Data: data}, nil
}

func (s *Server) SessionImport(_ context.Context, blob schema.BareclawSessionBlob) (schema.BareclawEmpty, error) {
	a, err := s.agent()
	if err != nil {
		return schema.BareclawEmpty{}, err
	}
	return schema.BareclawEmpty{}, s.restore(a, blob)
}

func (s *Server) StateExport(context.Context, schema.BareclawEmpty) (schema.BareclawStateBlob, error) {
	a, err := s.agent()
	if err != nil {
		return schema.BareclawStateBlob{}, err
	}
	keys := a.Sessions.ListSessions()
	blobs := make([]schema.BareclawSessionBlob, 0, len(keys))
	for _, key := range keys {
		data, err := marshalSession(a.Sessions.GetHistory(key), a.Sessions.GetSummary(key))
		if err != nil {
			return schema.BareclawStateBlob{}, fmt.Errorf("session %s: %w", key, err)
		}
		blobs = append(blobs, schema.BareclawSessionBlob{Key: key, Data: data})
	}
	return schema.BareclawStateBlob{Sessions: blobs}, nil
}

func (s *Server) StateImport(_ context.Context, state schema.BareclawStateBlob) (schema.BareclawEmpty, error) {
	a, err := s.agent()
	if err != nil {
		return schema.BareclawEmpty{}, err
	}
	for _, blob := range state.Sessions {
		if err := s.restore(a, blob); err != nil {
			return schema.BareclawEmpty{}, err
		}
	}
	return schema.BareclawEmpty{}, nil
}

func (s *Server) ToolRegister(_ context.Context, def schema.BareclawToolDef) (schema.BareclawEmpty, error) {
	var params map[string]any
	if len(def.InputSchema) > 0 {
		if err := json.Unmarshal(def.InputSchema, &params); err != nil {
			return schema.BareclawEmpty{}, fmt.Errorf("bad inputSchema JSON: %w", err)
		}
	}
	s.loop.RegisterTool(&jsTool{name: def.Name, description: def.Description, params: params, server: s})
	return schema.BareclawEmpty{}, nil
}

func (s *Server) agent() (*agent.AgentInstance, error) {
	a := s.loop.GetRegistry().GetDefaultAgent()
	if a == nil {
		return nil, fmt.Errorf("no default agent")
	}
	return a, nil
}

func (s *Server) restore(a *agent.AgentInstance, blob schema.BareclawSessionBlob) error {
	history, summary, err := unmarshalSession(blob.Data)
	if err != nil {
		return fmt.Errorf("session %s: %w", blob.Key, err)
	}
	a.Sessions.SetHistory(blob.Key, history)
	a.Sessions.SetSummary(blob.Key, summary)
	if err := a.Sessions.Save(blob.Key); err != nil {
		return fmt.Errorf("save %s: %w", blob.Key, err)
	}
	return nil
}
