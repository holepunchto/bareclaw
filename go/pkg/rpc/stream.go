package rpc

import (
	"context"
	"sync"

	bare "github.com/holepunchto/bare-rpc-golang"
	c "github.com/holepunchto/compact-encoding-golang"
	"github.com/sipeed/picoclaw/pkg/bus"
)

// rpcStreamer implements bus.Streamer over a bare-rpc OutgoingStream.
// One instance is created per in-flight CHAT request.
type rpcStreamer struct {
	stream *bare.OutgoingStream
}

func newStreamer(stream *bare.OutgoingStream) *rpcStreamer {
	return &rpcStreamer{stream: stream}
}

func (s *rpcStreamer) Update(_ context.Context, content string) error {
	chunk := ChatChunk{Type: ChunkContent, Content: content}
	data, err := c.Marshal(&chunk)
	if err != nil {
		return err
	}
	_, err = s.stream.Write(data)
	return err
}

func (s *rpcStreamer) Finalize(_ context.Context, content string) error {
	chunk := ChatChunk{Type: ChunkDone, Content: content}
	data, _ := c.Marshal(&chunk)
	_, _ = s.stream.Write(data)
	return nil
}

func (s *rpcStreamer) Cancel(_ context.Context) {
	// The stream is closed by handleChat after ProcessDirectWithChannel returns.
}

// StreamDelegate implements bus.StreamDelegate. It maps "channel:chatID" → rpcStreamer,
// one entry per in-flight CHAT request.
type StreamDelegate struct {
	mu        sync.Mutex
	streamers map[string]*rpcStreamer
}

func NewStreamDelegate() *StreamDelegate {
	return &StreamDelegate{streamers: make(map[string]*rpcStreamer)}
}

func (d *StreamDelegate) register(channel, chatID string, s *rpcStreamer) {
	d.mu.Lock()
	d.streamers[channel+":"+chatID] = s
	d.mu.Unlock()
}

func (d *StreamDelegate) unregister(channel, chatID string) {
	d.mu.Lock()
	delete(d.streamers, channel+":"+chatID)
	d.mu.Unlock()
}

// GetStreamer satisfies bus.StreamDelegate. The agent pipeline calls this to
// discover whether the current channel+chatID pair has streaming available.
func (d *StreamDelegate) GetStreamer(_ context.Context, channel, chatID, _ string) (bus.Streamer, bool) {
	d.mu.Lock()
	s, ok := d.streamers[channel+":"+chatID]
	d.mu.Unlock()
	if !ok {
		return nil, false
	}
	return s, true
}
