package rpc

import (
	"context"
	"io"

	bare "github.com/holepunchto/bare-rpc-golang"
	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/bus"
)

// Server wires an AgentLoop to a bare-rpc transport over any io.ReadWriter.
type Server struct {
	loop     *agent.AgentLoop
	bus      *bus.MessageBus
	delegate *StreamDelegate
	rpc      *bare.RPC
}

func NewServer(loop *agent.AgentLoop, msgBus *bus.MessageBus, delegate *StreamDelegate) *Server {
	return &Server{loop: loop, bus: msgBus, delegate: delegate}
}

// Listen starts the RPC read loop. Blocks until the stream closes or ctx is cancelled.
func (s *Server) Listen(ctx context.Context, stream io.ReadWriter) error {
	s.rpc = bare.NewRPC(stream)

	return s.rpc.Listen(func(req *bare.Request) {
		switch uint(req.Command) {
		case CmdChat:
			go s.handleChat(ctx, req)
		case CmdSessionCreate:
			go s.handleSessionCreate(ctx, req)
		case CmdSessionList:
			go s.handleSessionList(ctx, req)
		case CmdSessionExport:
			go s.handleSessionExport(ctx, req)
		case CmdSessionImport:
			go s.handleSessionImport(ctx, req)
		case CmdStateExport:
			go s.handleStateExport(ctx, req)
		case CmdStateImport:
			go s.handleStateImport(ctx, req)
		case CmdToolRegister:
			go s.handleToolRegister(ctx, req)
		}
	})
}
