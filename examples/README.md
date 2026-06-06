# bareclaw examples

P2P agent demos. Each is self-contained and runs with `bare <file>`. They
default to a local Ollama (`provider: 'ollama', model: 'llama3.2'`) passed via
`opts` — start one first:

```sh
ollama run llama3.2
```

> The local model is only there so the demos are zero-cost. `llama3.2` is small
> and rambly (and won't reliably _call_ tools) — the point of these examples is
> the **P2P wiring**, which works regardless. Swap in a capable model via `opts`
> for coherent output and real tool use.

## `swarm-collab.js` — two agents collaborate over a Hyperswarm

```sh
bare examples/swarm-collab.js
```

Two agents (each its own Corestore + its own Hyperswarm instance) discover each
other on a shared topic and relay turns, building a plan together. This is the
"agents find each other and work together, no server" pattern.

## `peer-scan-tool.js` — give an agent a P2P tool

```sh
bare examples/peer-scan-tool.js
```

Registers a `scan_peers` tool (via `registerTool`) that joins a Hyperswarm
lobby, counts the peers it finds, and leaves. A few decoy peers populate the
lobby so there's a crowd to discover. This is the core of bridging the Go agent
into the Holepunch stack: the tool runs in JS-on-Bare, so it has Hyperswarm /
Hyperbee / Hyperdrive / the DHT at hand.

## `dht-shared.js` — one-to-many sharing through a HyperDHT server

```sh
bare examples/dht-shared.js
```

A single HyperDHT **server** (a known rendezvous) collects one idea from each
agent that connects, then fans the merged board back out to all of them — a tiny
distributed blackboard. Use this when you want a stable hub sharing state to N
clients, versus Hyperswarm's topic-based many-to-many discovery.

## `swarm-code-review.js` — a multi-agent code review panel

```sh
bare examples/swarm-code-review.js
```

The payoff demo. Lenses: `bugs`, `security`, `design`, `quality` (correctness +
clean Unix-style structure). Because small models are noisy, **two agents per
lens** so you can see where they agree (high confidence) vs diverge.

- The **hub (leader) reads the diff once and pushes it** to each reviewer over
  the DHT — so the reviewers need no repo and this works unchanged across
  machines. Only findings travel back.
- A **correlator** agent pulls the full board off the hub and weighs agreement.
- The console shows a computed **consensus table** + an attributed **action
  list** (what / who / why) — both derived structurally, so they stay readable
  even when a model rambles. JSON tool-call noise is stripped.
- A self-contained `review.md` (action items + consensus + findings + diff) is
  written for another LLM to act on.

Tune `CATEGORIES`, `PER_CATEGORY`, and `BASE`. This is where a capable model in
`OPTS` really pays off.
