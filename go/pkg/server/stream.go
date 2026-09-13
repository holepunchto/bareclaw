package server

import (
	"context"
	"sync"

	"github.com/sipeed/picoclaw/pkg/bus"

	"github.com/holepunchto/bareclaw/hrpc"
	"github.com/holepunchto/bareclaw/schema"
)

// streamer forwards a chat turn's streamed text onto its response stream; Chat owns the terminal chunk.
type streamer struct {
	out       *hrpc.SendStream[schema.BareclawChatChunk]
	published bool
}

func newStreamer(out *hrpc.SendStream[schema.BareclawChatChunk]) *streamer {
	return &streamer{out: out}
}

func (s *streamer) Update(_ context.Context, content string) error {
	if err := s.out.Send(schema.BareclawChatChunk{Type: schema.BareclawChunkTypeContent, Content: content}); err != nil {
		return err
	}
	s.published = true
	return nil
}

func (s *streamer) Finalize(context.Context, string) error { return nil }

func (s *streamer) Cancel(context.Context) {}

// StreamDelegate implements bus.StreamDelegate, one streamer per in-flight chat keyed by channel and chat id.
type StreamDelegate struct {
	mu        sync.Mutex
	streamers map[string]*streamer
}

func NewStreamDelegate() *StreamDelegate {
	return &StreamDelegate{streamers: make(map[string]*streamer)}
}

func (d *StreamDelegate) register(channel, chatID string, s *streamer) {
	d.mu.Lock()
	d.streamers[channel+":"+chatID] = s
	d.mu.Unlock()
}

func (d *StreamDelegate) unregister(channel, chatID string) {
	d.mu.Lock()
	delete(d.streamers, channel+":"+chatID)
	d.mu.Unlock()
}

func (d *StreamDelegate) GetStreamer(_ context.Context, channel, chatID, _ string) (bus.Streamer, bool) {
	d.mu.Lock()
	s, ok := d.streamers[channel+":"+chatID]
	d.mu.Unlock()
	if !ok {
		return nil, false
	}
	return s, true
}
