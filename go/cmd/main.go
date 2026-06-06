package main

import (
	"context"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/logger"
	"github.com/sipeed/picoclaw/pkg/providers"

	"github.com/holepunchto/bareclaw/pkg/rpc"
)

func main() {
	// stdout is the bare-rpc transport — picoclaw's console logger writes there
	// by default and would corrupt the frame stream. Silence every terminal sink
	// before anything can log: all communication with the Bare side is RPC-based.
	logger.DisableConsole()
	log.SetOutput(io.Discard)

	// Config file (optional — individual flags below take precedence or can be used alone)
	configPath := flag.String("config", "", "path to picoclaw config file")
	provider := flag.String("provider", "", "LLM provider name (e.g. anthropic, openai)")
	apiKey := flag.String("api-key", "", "API key for the provider")
	modelName := flag.String("model", "", "model name / alias")
	apiBase := flag.String("api-base", "", "custom API base URL")
	flag.Parse()

	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		// Nothing may be written to the terminal; signal failure via exit code.
		os.Exit(1)
	}

	// Inject CLI-supplied values on top of whatever the file (or default) provided.
	if *provider != "" || *apiKey != "" || *modelName != "" {
		mc := &config.ModelConfig{
			Provider:  *provider,
			ModelName: *modelName,
			Model:     *modelName,
			APIBase:   *apiBase,
			Enabled:   true,
		}
		if *apiKey != "" {
			mc.SetAPIKey(*apiKey)
		}
		cfg.ModelList = append(cfg.ModelList, mc)
	}
	if *provider != "" {
		cfg.Agents.Defaults.Provider = *provider
	}
	if *modelName != "" {
		cfg.Agents.Defaults.ModelName = *modelName
	}

	llmProvider, modelID, err := providers.CreateProvider(cfg)
	if err != nil {
		// Non-fatal: session/state commands work without an LLM. Chat replies
		// with a CHUNK_ERROR frame instead.
		llmProvider = nil
		modelID = ""
	}
	if modelID != "" {
		cfg.Agents.Defaults.ModelName = modelID
	}

	msgBus := bus.NewMessageBus()
	defer msgBus.Close()

	delegate := rpc.NewStreamDelegate()
	msgBus.SetStreamDelegate(delegate)

	agentLoop := agent.NewAgentLoop(cfg, msgBus, llmProvider)
	defer agentLoop.Close()

	server := rpc.NewServer(agentLoop, msgBus, delegate)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	if err := server.Listen(ctx, readWriter{os.Stdin, os.Stdout}); err != nil {
		// A read error (EOF on stdin) is the normal shutdown path when the Bare
		// side closes the pipe; exit non-zero only on an unexpected failure.
		if ctx.Err() == nil && err != io.EOF {
			os.Exit(1)
		}
	}
}

type readWriter struct {
	io.Reader
	io.Writer
}
