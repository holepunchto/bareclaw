package rpc

import (
	"context"
	"encoding/json"
	"fmt"

	bare "github.com/holepunchto/bare-rpc-golang"
	c "github.com/holepunchto/compact-encoding-golang"
	toolshared "github.com/sipeed/picoclaw/pkg/tools/shared"
)

// handleToolRegister registers a JS-side tool so the agent can call it.
// When invoked the server sends CmdToolExec to JS and waits for a ToolResult reply.
func (s *Server) handleToolRegister(_ context.Context, req *bare.Request) {
	var def ToolDef
	if err := c.Unmarshal(req.Data, &def); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad ToolDef: %w", err))
		return
	}

	var schema map[string]any
	if len(def.InputSchema) > 0 {
		if err := json.Unmarshal(def.InputSchema, &schema); err != nil {
			_ = req.ReplyError(fmt.Errorf("bad InputSchema JSON: %w", err))
			return
		}
	}

	s.loop.RegisterTool(&jsBackedTool{
		name:        def.Name,
		description: def.Description,
		schema:      schema,
		server:      s,
	})
	_ = req.Reply(nil)
}

// jsBackedTool implements tools/toolshared.Tool and delegates execution to JS via CmdToolExec.
type jsBackedTool struct {
	name        string
	description string
	schema      map[string]any
	server      *Server
}

func (t *jsBackedTool) Name() string               { return t.name }
func (t *jsBackedTool) Description() string        { return t.description }
func (t *jsBackedTool) Parameters() map[string]any { return t.schema }

func (t *jsBackedTool) Execute(ctx context.Context, args map[string]any) *toolshared.ToolResult {
	input, err := json.Marshal(args)
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool marshal error: %v", err))
	}

	call := ToolCall{
		CallID: fmt.Sprintf("tc-%p", &args),
		Name:   t.name,
		Input:  input,
	}
	payload, err := c.Marshal(&call)
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool encode error: %v", err))
	}

	replyData, err := t.server.rpc.Request(CmdToolExec, payload)
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool exec RPC error: %v", err))
	}

	var result ToolResult
	if err := c.Unmarshal(replyData, &result); err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool result decode error: %v", err))
	}
	if result.ErrMsg != "" {
		return toolshared.NewToolResult(fmt.Sprintf("tool error: %s", result.ErrMsg))
	}

	return toolshared.NewToolResult(string(result.Output))
}
