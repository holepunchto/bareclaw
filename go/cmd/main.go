package main

import (
	"context"
	"encoding/json"
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
	"github.com/sipeed/picoclaw/pkg/tools"

	"github.com/holepunchto/bareclaw/pkg/rpc"
)

func main() {
	// stdout is the bare-rpc transport — picoclaw's console logger writes there
	// by default and would corrupt the frame stream. Silence every terminal sink
	// before anything can log: all communication with the Bare side is RPC-based.
	logger.DisableConsole()
	log.SetOutput(io.Discard)

	// Config is supplied by the Bare side: either inline JSON (preferred — passed
	// straight through `opts.config`) or a file path. Individual flags below take
	// precedence or can be used alone.
	configPath := flag.String("config", "", "path to picoclaw config file")
	configJSON := flag.String("config-json", "", "inline picoclaw config JSON, merged over defaults")
	provider := flag.String("provider", "", "LLM provider name (e.g. anthropic, openai)")
	apiKey := flag.String("api-key", "", "API key for the provider")
	modelName := flag.String("model", "", "model name / alias")
	apiBase := flag.String("api-base", "", "custom API base URL")
	builtinTools := flag.Bool("builtin-tools", false, "keep picoclaw's built-in OS tools (off by default; bareclaw agents get tools via registerTool)")
	flag.Parse()

	var cfg *config.Config
	var err error
	if *configJSON != "" {
		// Merge the inline config over the defaults (same as a config file would),
		// so callers only specify what they want to change.
		cfg = config.DefaultConfig()
		if err = json.Unmarshal([]byte(*configJSON), cfg); err != nil {
			os.Exit(1) // nothing may reach the terminal; signal via exit code
		}
	} else if cfg, err = config.LoadConfig(*configPath); err != nil {
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

	// A bareclaw agent is lean by default: its tools come from the Bare side via
	// registerTool, not picoclaw's built-in OS tools. Those built-ins operate on
	// the Go process (not your app) and make small models emit tool-call noise,
	// so clear them unless the caller explicitly opts back in. registerTool then
	// populates this empty registry.
	if !*builtinTools {
		if a := agentLoop.GetRegistry().GetDefaultAgent(); a != nil {
			a.Tools = tools.NewToolRegistry()
		}
	}

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
