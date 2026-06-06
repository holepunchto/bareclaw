import { spawnRPC } from './lib/spawn.js'
import * as codecs from './lib/codecs.js'

export class Picoclaw {
  constructor (store, opts = {}) {
    this._store = store  // Hyperbee instance or null
    this._opts = opts
    this._rpc = null
    this._proc = null
    this._tools = new Map()
    this._ready = false
  }

  async ready () {
    const { rpc, proc } = spawnRPC({
      binary: this._opts.binary,
      config: this._opts.config
    })
    this._rpc = rpc
    this._proc = proc

    // Handle Go → JS callbacks
    rpc.on('request', (req) => this._onRequest(req))

    // Restore state from Hyperbee before the first turn
    if (this._store) await this._loadFromStore()

    this._ready = true
  }

  // chat(sessionId, message, opts?) → AsyncGenerator of chunks
  // Each chunk: { type, content } where type is CHUNK_* constant
  async * chat (sessionId, message, opts = {}) {
    this._assertReady()
    const req = this._rpc.request(codecs.CMD_CHAT)
    await req.send(codecs.chatRequest.encode({
      sessionId,
      message,
      model: opts.model || this._opts.model || ''
    }))

    const stream = req.createResponseStream()
    for await (const chunk of stream) {
      const decoded = codecs.chatChunk.decode(chunk)
      yield decoded
      if (decoded.type === codecs.CHUNK_DONE || decoded.type === codecs.CHUNK_ERROR) break
    }
  }

  // session(scope) → sessionId string
  async session (scope = {}) {
    this._assertReady()
    const reply = await this._rpc.request(
      codecs.CMD_SESSION_CREATE,
      codecs.sessionScope.encode(scope)
    )
    return codecs.sessionKey.decode(reply).key
  }

  // sessions() → string[]
  async sessions () {
    this._assertReady()
    const reply = await this._rpc.request(codecs.CMD_SESSION_LIST, null)
    return codecs.sessionList.decode(reply)
  }

  // exportSession(key) → Buffer (opaque blob for Hyperbee)
  async exportSession (key) {
    this._assertReady()
    return this._rpc.request(
      codecs.CMD_SESSION_EXPORT,
      codecs.sessionKey.encode({ key })
    )
  }

  // importSession(key, blob) — restore a session from a Hyperbee blob
  async importSession (key, blob) {
    this._assertReady()
    await this._rpc.request(
      codecs.CMD_SESSION_IMPORT,
      codecs.sessionBlob.encode({ key, data: blob })
    )
  }

  // registerTool(name, description, schema, handler)
  // handler(input) → output  (both plain JS objects, serialised as JSON)
  async registerTool (name, description, schema, handler) {
    this._assertReady()
    this._tools.set(name, handler)
    await this._rpc.request(
      codecs.CMD_TOOL_REGISTER,
      codecs.toolDef.encode({ name, description, inputSchema: schema })
    )
  }

  async close () {
    if (!this._rpc) return
    if (this._store) {
      const blob = await this._rpc.request(codecs.CMD_STATE_EXPORT, null)
      await this._store.put('picoclaw/snapshot', blob)
    }
    this._rpc.destroy()
    this._proc.kill()
    this._rpc = null
    this._proc = null
    this._ready = false
  }

  // --- internals ---

  _assertReady () {
    if (!this._ready) throw new Error('bareclaw: call await picoclaw.ready() first')
  }

  async _onRequest (req) {
    switch (req.command) {
      case codecs.CMD_TOOL_EXEC: {
        const call = codecs.toolCall.decode(req.data)
        const handler = this._tools.get(call.name)
        try {
          const output = handler ? await handler(call.input) : null
          await req.reply(codecs.toolResult.encode({ callId: call.callId, output }))
        } catch (err) {
          await req.reply(codecs.toolResult.encode({
            callId: call.callId,
            output: null,
            errMsg: err.message || String(err)
          }))
        }
        break
      }

      case codecs.CMD_STATE_CHANGED: {
        if (!this._store) break
        const chunk = codecs.stateChunk.decode(req.data)
        const field = chunk.field === codecs.STATE_FIELD_SUMMARY ? 'summary' : 'history'
        await this._store.put(`picoclaw/sessions/${chunk.sessionKey}/${field}`, chunk.data)
        break
      }
    }
  }

  async _loadFromStore () {
    const keys = await this._listStoreKeys('picoclaw/sessions/')
    for (const sessionKey of keys) {
      const historyEntry = await this._store.get(`picoclaw/sessions/${sessionKey}/history`)
      const summaryEntry = await this._store.get(`picoclaw/sessions/${sessionKey}/summary`)
      if (!historyEntry && !summaryEntry) continue

      const data = this._assembleSessionBlob(
        historyEntry ? historyEntry.value : null,
        summaryEntry ? summaryEntry.value : null
      )
      await this._rpc.request(
        codecs.CMD_SESSION_IMPORT,
        codecs.sessionBlob.encode({ key: sessionKey, data })
      )
    }
  }

  // Collect unique session keys from Hyperbee key prefixes like
  // "picoclaw/sessions/<key>/history"
  async _listStoreKeys (prefix) {
    const seen = new Set()
    for await (const entry of this._store.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      const rest = entry.key.slice(prefix.length)
      const sessionKey = rest.split('/')[0]
      if (sessionKey) seen.add(sessionKey)
    }
    return [...seen]
  }

  // Reconstruct the JSON envelope that Go's unmarshalSessionPayload expects:
  // { "h": [raw messages], "s": "summary" }
  _assembleSessionBlob (historyBuf, summaryBuf) {
    // The history blob stored per-chunk IS the JSON already, but the SessionBlob
    // on the Go side expects the full { h, s } JSON envelope.
    const h = historyBuf ? JSON.parse(historyBuf.toString()) : []
    const s = summaryBuf ? summaryBuf.toString() : ''
    return Buffer.from(JSON.stringify({ h, s }))
  }
}
