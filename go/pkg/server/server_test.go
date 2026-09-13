package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"

	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"

	"github.com/holepunchto/bareclaw/hrpc"
	"github.com/holepunchto/bareclaw/schema"
)

// jsSide stands in for the Bare side: it serves ToolExec and records what it was asked.
type jsSide struct {
	hrpc.UnimplementedServer
	calls chan schema.BareclawToolCall
}

func (j *jsSide) ToolExec(_ context.Context, call schema.BareclawToolCall) (schema.BareclawToolResult, error) {
	j.calls <- call
	return schema.BareclawToolResult{CallId: call.CallId, Output: []byte(`{"result":"olleh"}`)}, nil
}

func pair(t *testing.T) (*hrpc.HRPC, *Server, *jsSide) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.Agents.Defaults.Workspace = t.TempDir()
	msgBus := bus.NewMessageBus()
	delegate := NewStreamDelegate()
	msgBus.SetStreamDelegate(delegate)
	loop := agent.NewAgentLoop(cfg, msgBus, nil)
	t.Cleanup(func() { loop.Close(); msgBus.Close() })

	c1, c2 := net.Pipe()
	srv := New(loop, delegate, errors.New("no provider configured"))
	goSide := hrpc.New(c1, srv)
	srv.Attach(goSide)
	js := &jsSide{calls: make(chan schema.BareclawToolCall, 1)}
	client := hrpc.New(c2, js)
	t.Cleanup(func() { client.Close(); goSide.Close() })
	return client, srv, js
}

func TestSessionRoundTrip(t *testing.T) {
	client, _, _ := pair(t)
	ctx := context.Background()

	key, err := client.SessionCreate(ctx, schema.BareclawSessionScope{AgentId: "test", Channel: "general"})
	if err != nil || key.Key == "" {
		t.Fatalf("SessionCreate: %v %+v", err, key)
	}
	again, _ := client.SessionCreate(ctx, schema.BareclawSessionScope{AgentId: "test", Channel: "general"})
	if again.Key != key.Key {
		t.Fatal("session key is not deterministic")
	}

	blob := schema.BareclawSessionBlob{Key: key.Key, Data: []byte(`{"h":[{"role":"user","content":"hi"}],"s":"sum"}`)}
	if _, err := client.SessionImport(ctx, blob); err != nil {
		t.Fatal(err)
	}
	list, err := client.SessionList(ctx, schema.BareclawEmpty{})
	if err != nil || len(list.Keys) != 1 || list.Keys[0] != key.Key {
		t.Fatalf("SessionList: %v %+v", err, list)
	}
	exported, err := client.SessionExport(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	var dump sessionDump
	if err := json.Unmarshal(exported.Data, &dump); err != nil || len(dump.History) != 1 || dump.Summary != "sum" {
		t.Fatalf("export: %v %s", err, exported.Data)
	}

	state, err := client.StateExport(ctx, schema.BareclawEmpty{})
	if err != nil || len(state.Sessions) != 1 {
		t.Fatalf("StateExport: %v %+v", err, state)
	}
}

func TestToolExecRoundTrip(t *testing.T) {
	client, srv, js := pair(t)
	ctx := context.Background()

	def := schema.BareclawToolDef{Name: "reverse", Description: "reverses", InputSchema: []byte(`{"type":"object"}`)}
	if _, err := client.ToolRegister(ctx, def); err != nil {
		t.Fatal(err)
	}

	tool := &jsTool{name: "reverse", server: srv}
	result := tool.Execute(ctx, map[string]any{"text": "hello"})
	call := <-js.calls
	if call.Name != "reverse" || string(call.Input) != `{"text":"hello"}` {
		t.Fatalf("call = %+v", call)
	}
	if result.ForLLM != `{"result":"olleh"}` {
		t.Fatalf("result = %+v", result)
	}
}

func TestChatWithoutProviderReportsError(t *testing.T) {
	client, _, _ := pair(t)

	stream, err := client.Chat(schema.BareclawChatRequest{SessionId: "s", Message: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := stream.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if chunk.Type != schema.BareclawChunkTypeError || chunk.Content == "" {
		t.Fatalf("chunk = %+v", chunk)
	}
}
