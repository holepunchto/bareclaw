const Hyperbee = require('hyperbee2')
const ReadyResource = require('ready-resource')
const b4a = require('b4a')

const { spawnRPC } = require('./lib/spawn.js')
const codecs = require('./lib/codecs.js')

class Bareclaw extends ReadyResource {
  constructor(store, opts = {}) {
    super()

    this._store = store
    this._bee = new Hyperbee(this._store)
    this._opts = opts
    this._rpc = null
    this._proc = null
    this._tools = new Map()

    this.ready().catch(noop)
  }

  async _open() {
    await this._bee.ready()

    const { rpc, proc } = spawnRPC(this._opts, (req) => this._onRequest(req))
    this._rpc = rpc
    this._proc = proc

    await this._loadFromStore()
  }

  async _close() {
    if (!this._rpc) return

    // Flush each session's final state into the bee before tearing Go down.
    const keys = await this._listStoreKeys('picoclaw/sessions/')
    for (const key of keys) await this._persistSession(key)
    await this._bee.close()

    await this._shutdownProc()
    this._rpc = null
    this._proc = null
    this._bee = null
  }

  // Go's RPC loop blocks on a stdin read; SIGTERM is trapped by its signal
  // handler but can't interrupt that read. Closing stdin delivers EOF, so Go
  // returns from Listen and exits cleanly. SIGKILL is a backstop if it doesn't.
  _shutdownProc() {
    const proc = this._proc
    return new Promise((resolve) => {
      const force = setTimeout(() => proc.kill(9), 2000)
      proc.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      proc.stdin.end()
    })
  }

  async *chat(sessionId, message, opts = {}) {
    if (!this.opened) await this.ready()
    const req = this._rpc.request(codecs.CMD_CHAT)
    req.send(
      codecs.chatRequest.encode({
        sessionId,
        message,
        model: opts.model || this._opts.model || ''
      })
    )

    const stream = req.createResponseStream()
    try {
      for await (const chunk of stream) {
        const { type, content } = codecs.chatChunk.decode(chunk)
        const name = codecs.CHUNK_TYPE_NAMES[type]
        const done = name === 'done' || name === 'error'

        if (done) {
          yield { type: name, done }
          break
        } else {
          yield { type: name, content, done }
        }
      }
    } finally {
      // Persist the (now updated) session history into the bee automatically.
      // In a `finally` so it runs even when the caller breaks the stream early
      // (a plain statement after the loop is skipped by the generator's return).
      await this._persistSession(sessionId)
    }
  }

  async session(scope = {}) {
    if (!this.opened) await this.ready()
    const req = this._rpc.request(codecs.CMD_SESSION_CREATE)
    req.send(codecs.sessionScope.encode(scope))
    const reply = await req.reply()
    const key = codecs.sessionKey.decode(reply).key

    // The bee is the session registry — record the scope so the session is
    // listed (and survives restarts) even before any chat history exists.
    const w = this._bee.write()
    w.tryPut(b4a.from(`picoclaw/sessions/${key}/scope`), b4a.from(JSON.stringify(scope)))
    await w.flush()

    return key
  }

  async sessions() {
    if (!this.opened) await this.ready()
    return this._listStoreKeys('picoclaw/sessions/')
  }

  async exportSession(key) {
    if (!this.opened) await this.ready()
    const req = this._rpc.request(codecs.CMD_SESSION_EXPORT)
    req.send(codecs.sessionKey.encode({ key }))
    const reply = await req.reply()
    return codecs.sessionBlob.decode(reply).data
  }

  async importSession(key, blob) {
    if (!this.opened) await this.ready()
    const req = this._rpc.request(codecs.CMD_SESSION_IMPORT)
    req.send(codecs.sessionBlob.encode({ key, data: blob }))
    await req.reply()

    const w = this._bee.write()
    w.tryPut(b4a.from(`picoclaw/sessions/${key}/data`), blob)
    await w.flush()
  }

  async registerTool(name, description, schema, handler) {
    if (!this.opened) await this.ready()
    this._tools.set(name, handler)
    const req = this._rpc.request(codecs.CMD_TOOL_REGISTER)
    req.send(codecs.toolDef.encode({ name, description, inputSchema: schema }))
    await req.reply()
  }

  async _onRequest(req) {
    switch (req.command) {
      case codecs.CMD_TOOL_EXEC: {
        const call = codecs.toolCall.decode(req.data)
        const handler = this._tools.get(call.name)
        try {
          const output = handler ? await handler(call.input) : null
          await req.reply(codecs.toolResult.encode({ callId: call.callId, output }))
        } catch (err) {
          await req.reply(
            codecs.toolResult.encode({
              callId: call.callId,
              output: null,
              errMsg: err.message || String(err)
            })
          )
        }
        break
      }

      case codecs.CMD_STATE_CHANGED: {
        if (!this._bee) break
        const chunk = codecs.stateChunk.decode(req.data)
        await this._persistSession(chunk.sessionKey)
        break
      }
    }
  }

  // Export a session's current state from Go and store it in the bee under its
  // canonical per-session key. Safe to call after any turn that mutated state.
  async _persistSession(key) {
    if (!this._rpc || !this._bee) return
    const blob = await this.exportSession(key)
    const w = this._bee.write()
    w.tryPut(b4a.from(`picoclaw/sessions/${key}/data`), blob)
    await w.flush()
  }

  async _loadFromStore() {
    // Restore each persisted session into Go so chat history survives restarts.
    const keys = await this._listStoreKeys('picoclaw/sessions/')
    for (const sessionKey of keys) {
      const entry = await this._bee.get(b4a.from(`picoclaw/sessions/${sessionKey}/data`))
      if (!entry || !entry.value || entry.value.length === 0) continue

      const req = this._rpc.request(codecs.CMD_SESSION_IMPORT)
      req.send(codecs.sessionBlob.encode({ key: sessionKey, data: entry.value }))
      await req.reply()
    }
  }

  async _listStoreKeys(prefix) {
    const seen = new Set()
    const range = { gte: b4a.from(prefix), lt: b4a.from(prefix + '\xff') }
    for await (const entry of this._bee.createReadStream(range)) {
      const rest = entry.key.toString().slice(prefix.length)
      const sessionKey = rest.split('/')[0]
      if (sessionKey) seen.add(sessionKey)
    }
    return [...seen]
  }
}

module.exports = { Bareclaw }

function noop() {}
