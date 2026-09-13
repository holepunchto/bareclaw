package server

import (
	"context"
	"encoding/json"
	"fmt"

	toolshared "github.com/sipeed/picoclaw/pkg/tools/shared"

	"github.com/holepunchto/bareclaw/schema"
)

// jsTool is a tool registered from JavaScript; the agent's calls are forwarded there over ToolExec.
type jsTool struct {
	name        string
	description string
	params      map[string]any
	server      *Server
}

func (t *jsTool) Name() string               { return t.name }
func (t *jsTool) Description() string        { return t.description }
func (t *jsTool) Parameters() map[string]any { return t.params }

func (t *jsTool) Execute(ctx context.Context, args map[string]any) *toolshared.ToolResult {
	input, err := json.Marshal(args)
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool marshal error: %v", err))
	}
	rpc, err := t.server.client(ctx)
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool exec error: %v", err))
	}
	result, err := rpc.ToolExec(ctx, schema.BareclawToolCall{
		CallId: fmt.Sprintf("tc-%d", t.server.callIDs.Add(1)),
		Name:   t.name,
		Input:  input,
	})
	if err != nil {
		return toolshared.NewToolResult(fmt.Sprintf("tool exec RPC error: %v", err))
	}
	if result.ErrMsg != "" {
		return toolshared.NewToolResult(fmt.Sprintf("tool error: %s", result.ErrMsg))
	}
	return toolshared.NewToolResult(string(result.Output))
}
