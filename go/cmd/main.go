package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers"

	"github.com/holepunchto/bareclaw/pkg/rpc"
)

func main() {
	configPath := flag.String("config", "", "path to picoclaw config file")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	provider, modelID, err := providers.CreateProvider(cfg)
	if err != nil {
		log.Fatalf("provider: %v", err)
	}
	if modelID != "" {
		cfg.Agents.Defaults.ModelName = modelID
	}

	msgBus := bus.NewMessageBus()
	defer msgBus.Close()

	delegate := rpc.NewStreamDelegate()
	msgBus.SetStreamDelegate(delegate)

	agentLoop := agent.NewAgentLoop(cfg, msgBus, provider)
	defer agentLoop.Close()

	server := rpc.NewServer(agentLoop, msgBus, delegate)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// The RPC transport is stdin+stdout. stderr is left free for logs so the
	// JS side can capture picoclaw diagnostics separately if needed.
	if err := server.Listen(ctx, readWriter{os.Stdin, os.Stdout}); err != nil {
		if ctx.Err() == nil {
			log.Fatalf("rpc: %v", err)
		}
	}
}

func loadConfig(path string) (*config.Config, error) {
	cfg, err := config.LoadConfig(path)
	if err != nil {
		return nil, fmt.Errorf("config load failed: %w", err)
	}
	return cfg, nil
}

// readWriter pairs stdin and stdout into a single io.ReadWriter for the RPC layer.
type readWriter struct {
	io.Reader
	io.Writer
}
