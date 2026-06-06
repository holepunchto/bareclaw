package rpc

import (
	"context"
	"fmt"

	bare "github.com/holepunchto/bare-rpc-golang"
	c "github.com/holepunchto/compact-encoding-golang"
)

func (s *Server) handleChat(ctx context.Context, req *bare.Request) {
	var chatReq ChatRequest
	if err := c.Unmarshal(req.Data, &chatReq); err != nil {
		_ = req.ReplyError(fmt.Errorf("bad ChatRequest: %w", err))
		return
	}

	// Open the response stream before starting the agent turn so the streamer
	// is registered and ready when the pipeline first calls Update.
	respStream := req.CreateResponseStream()

	chatID := fmt.Sprintf("rpc-%d", req.ID)
	streamer := newStreamer(respStream)
	s.delegate.register("rpc", chatID, streamer)
	defer s.delegate.unregister("rpc", chatID)

	_, err := s.loop.ProcessDirectWithChannel(ctx, chatReq.Message, chatReq.SessionID, "rpc", chatID)
	if err != nil {
		errChunk := ChatChunk{Type: ChunkError, Content: err.Error()}
		if data, encErr := c.Marshal(&errChunk); encErr == nil {
			_, _ = respStream.Write(data)
		}
	}

	respStream.Close()
}
