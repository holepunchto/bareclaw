// bareclaw serves a picoclaw agent over hrpc on the file descriptor its parent hands it (fd 3).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/holepunchto/bare-rpc-golang/ipc"
	"github.com/sipeed/picoclaw/pkg/agent"
	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/logger"
	"github.com/sipeed/picoclaw/pkg/providers"
	"github.com/sipeed/picoclaw/pkg/tools"

	"github.com/holepunchto/bareclaw/hrpc"
	"github.com/holepunchto/bareclaw/pkg/server"
)

const rpcFD = 3

func main() {
	// The Bare side owns the terminal; picoclaw's console output stays off.
	logger.DisableConsole()
	log.SetOutput(io.Discard)

	configPath := flag.String("config", "", "path to picoclaw config file")
	configJSON := flag.String("config-json", "", "inline picoclaw config JSON, merged over defaults")
	provider := flag.String("provider", "", "LLM provider name (e.g. anthropic, openai)")
	apiKey := flag.String("api-key", "", "API key for the provider")
	modelName := flag.String("model", "", "model name / alias")
	apiBase := flag.String("api-base", "", "custom API base URL")
	builtinTools := flag.Bool("builtin-tools", false, "keep picoclaw's built-in OS tools (off by default; tools come from registerTool)")
	flag.Parse()

	cfg, err := loadConfig(*configPath, *configJSON)
	if err != nil {
		fail(err)
	}

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

	// Without a reachable model the session and state commands still work; chat replies with an error chunk.
	llmProvider, modelID, providerErr := providers.CreateProvider(cfg)
	if providerErr != nil {
		llmProvider = nil
		modelID = ""
	}
	if modelID != "" {
		cfg.Agents.Defaults.ModelName = modelID
	}

	msgBus := bus.NewMessageBus()
	defer msgBus.Close()

	delegate := server.NewStreamDelegate()
	msgBus.SetStreamDelegate(delegate)

	agentLoop := agent.NewAgentLoop(cfg, msgBus, llmProvider)
	defer agentLoop.Close()

	// Lean by default: tools come from the Bare side, not picoclaw's OS tools.
	if !*builtinTools {
		if a := agentLoop.GetRegistry().GetDefaultAgent(); a != nil {
			a.Tools = tools.NewToolRegistry()
		}
	}

	conn, err := ipc.Inherited(rpcFD)
	if err != nil {
		fail(fmt.Errorf("bareclaw must be spawned with an RPC pipe on fd %d: %w", rpcFD, err))
	}

	srv := server.New(agentLoop, delegate, providerErr)
	rpc := hrpc.New(conn, srv)
	srv.Attach(rpc)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	select {
	case <-rpc.Done():
	case <-ctx.Done():
		rpc.Close()
		<-rpc.Done()
	}
	// EOF is the normal shutdown: the Bare side closed the pipe.
	if err := rpc.Err(); err != nil && err != io.EOF && ctx.Err() == nil {
		fail(err)
	}
}

func loadConfig(path, inline string) (*config.Config, error) {
	if inline != "" {
		cfg := config.DefaultConfig()
		if err := json.Unmarshal([]byte(inline), cfg); err != nil {
			return nil, fmt.Errorf("config-json: %w", err)
		}
		return cfg, nil
	}
	return config.LoadConfig(path)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "bareclaw:", err)
	os.Exit(1)
}
