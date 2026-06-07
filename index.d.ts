/**
 * bareclaw — a Bare library exposing the picoclaw AI agent over RPC.
 *
 * A {@link Bareclaw} instance spawns the Go `bareclaw` binary, persists session
 * state into a Hyperbee on the given Corestore, and streams chat responses back
 * as async iterables. Tools registered with {@link Bareclaw.registerTool} run in
 * JS and are invoked by the agent on demand.
 */

/** Options passed to the agent subprocess. */
export interface BareclawOptions {
  /** Model provider, e.g. `'ollama'`, `'anthropic'`, `'openai'`. */
  provider?: string
  /** Model name, e.g. `'lfm2.5'`. Used as the default for {@link Bareclaw.chat}. */
  model?: string
  /** API key for hosted providers. */
  apiKey?: string
  /** Override the provider's base URL. */
  apiBase?: string
  /** Inline config object (passed as JSON) or a path to a config file. */
  config?: Record<string, unknown> | string
  /** Opt back into picoclaw's built-in OS tools (off by default). */
  builtinTools?: boolean
}

/** Scope identifying a session; all fields are optional and default to `''`. */
export interface SessionScope {
  agentId?: string
  channel?: string
  account?: string
  peer?: string
}

/** Per-call overrides for {@link Bareclaw.chat}. */
export interface ChatOptions {
  /** Override the model for this turn (falls back to {@link BareclawOptions.model}). */
  model?: string
}

/** A streamed chat chunk. `content`/`thinking` carry text; `done`/`error` end the turn. */
export type ChatChunk =
  | { type: 'content' | 'thinking'; content: string; done: false }
  | { type: 'done' | 'error'; done: true }

/** Handler invoked when the agent calls a registered tool. */
export type ToolHandler = (input: any) => unknown | Promise<unknown>

export class Bareclaw {
  /**
   * @param store A ready (or to-be-readied) Corestore instance.
   * @param opts  Provider/model and other subprocess options.
   */
  constructor(store: any, opts?: BareclawOptions)

  /** Resolves once the agent subprocess and store are ready. */
  ready(): Promise<void>
  /** Flushes session state and tears down the subprocess and store. */
  close(): Promise<void>
  /** True once {@link Bareclaw.ready} has resolved. */
  readonly opened: boolean
  /** True once closing has begun. */
  readonly closing: boolean

  /**
   * Stream a chat turn. Yields {@link ChatChunk}s until a `done` (or `error`)
   * chunk. Session history is persisted automatically when the stream ends —
   * including when the caller breaks out early.
   */
  chat(sessionId: string, message: string, opts?: ChatOptions): AsyncIterableIterator<ChatChunk>

  /** Create a new session and return its key. */
  session(scope?: SessionScope): Promise<string>

  /** List the keys of all known sessions. */
  sessions(): Promise<string[]>

  /** Export a session's serialized state. */
  exportSession(key: string): Promise<Uint8Array>

  /** Import previously exported session state under `key`. */
  importSession(key: string, blob: Uint8Array): Promise<void>

  /**
   * Register a tool the agent can call. `schema` is a JSON Schema describing the
   * tool's input; `handler` receives the decoded input and returns the result.
   */
  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: ToolHandler
  ): Promise<void>
}
