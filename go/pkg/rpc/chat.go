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

	response, err := s.loop.ProcessDirectWithChannel(ctx, chatReq.Message, chatReq.SessionID, "rpc", chatID)
	if err != nil {
		writeChunk(respStream, ChatChunk{Type: ChunkError, Content: err.Error()})
		respStream.Close()
		return
	}

	// If the provider never streamed, deliver the full response as one Content
	// frame so callers always receive the text exactly once. The Done frame is a
	// pure terminator with no content, so the body is never delivered twice.
	if !streamer.published {
		writeChunk(respStream, ChatChunk{Type: ChunkContent, Content: response})
	}
	writeChunk(respStream, ChatChunk{Type: ChunkDone})
	respStream.Close()
}

func writeChunk(stream *bare.OutgoingStream, chunk ChatChunk) {
	if data, err := c.Marshal(&chunk); err == nil {
		_, _ = stream.Write(data)
	}
}
