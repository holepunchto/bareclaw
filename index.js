const Hyperbee = require('hyperbee2')
const ReadyResource = require('ready-resource')
const b4a = require('b4a')

const { spawnRPC } = require('./lib/spawn.js')

class Bareclaw extends ReadyResource {
  constructor(store, opts = {}) {
    super()

    this._store = store
    this._bee = new Hyperbee(this._store)
    this._opts = opts
    this._rpc = null
    this._proc = null
    this._pipe = null
    this._tools = new Map()

    this.ready().catch(noop)
  }

  async _open() {
    await this._bee.ready()

    const { rpc, proc, pipe } = spawnRPC(this._opts)
    this._rpc = rpc
    this._proc = proc
    this._pipe = pipe

    rpc.onToolExec((call) => this._onToolExec(call))
    rpc.onStateChanged((chunk) => this._persistSession(chunk.sessionKey))

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
    this._pipe = null
    this._bee = null
  }

  // Closing the RPC pipe delivers EOF to Go, which exits cleanly; SIGKILL is the backstop.
  _shutdownProc() {
    const proc = this._proc
    return new Promise((resolve) => {
      const force = setTimeout(() => proc.kill(9), 2000)
      proc.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      this._pipe.end()
    })
  }

  async *chat(sessionId, message, opts = {}) {
    if (!this.opened) await this.ready()
    const stream = this._rpc.chat({
      sessionId,
      message,
      model: opts.model || this._opts.model || ''
    })
    try {
      for await (const { type, content } of stream) {
        const done = type === 'done' || type === 'error'
        if (done) {
          yield type === 'error' ? { type, content, done } : { type, done }
          break
        }
        yield { type, content, done }
      }
    } finally {
      // Runs even when the caller breaks out early, so the turn is always persisted.
      await this._persistSession(sessionId)
    }
  }

  async session(scope = {}) {
    if (!this.opened) await this.ready()
    const { key } = await this._rpc.sessionCreate(scope)

    // The bee is the session registry, so the session is listed before any history exists.
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
    const { data } = await this._rpc.sessionExport({ key })
    return data
  }

  async importSession(key, blob) {
    if (!this.opened) await this.ready()
    await this._rpc.sessionImport({ key, data: blob })

    const w = this._bee.write()
    w.tryPut(b4a.from(`picoclaw/sessions/${key}/data`), blob)
    await w.flush()
  }

  async registerTool(name, description, schema, handler) {
    if (!this.opened) await this.ready()
    this._tools.set(name, handler)
    await this._rpc.toolRegister({
      name,
      description,
      inputSchema: schema ? b4a.from(JSON.stringify(schema)) : null
    })
  }

  async _onToolExec(call) {
    const handler = this._tools.get(call.name)
    try {
      const input = JSON.parse(b4a.toString(call.input))
      const output = handler ? await handler(input) : null
      return {
        callId: call.callId,
        output: output === null || output === undefined ? null : b4a.from(JSON.stringify(output)),
        errMsg: ''
      }
    } catch (err) {
      return { callId: call.callId, output: null, errMsg: err.message || String(err) }
    }
  }

  // Export a session's current state from Go and store it in the bee under its canonical key.
  async _persistSession(key) {
    if (!this._rpc || !this._bee) return
    const blob = await this.exportSession(key)
    const w = this._bee.write()
    w.tryPut(b4a.from(`picoclaw/sessions/${key}/data`), blob)
    await w.flush()
  }

  async _loadFromStore() {
    const keys = await this._listStoreKeys('picoclaw/sessions/')
    for (const key of keys) {
      const entry = await this._bee.get(b4a.from(`picoclaw/sessions/${key}/data`))
      if (!entry || !entry.value || entry.value.length === 0) continue
      await this._rpc.sessionImport({ key, data: entry.value })
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
