// P2P tools for bareclaw agents.
//
// Call registerP2PTools(bc) to hand a Bareclaw instance the full Holepunch
// stack as AI-callable tools. The model can then join swarms, run DHT servers,
// connect to peers by public key, and encode/decode binary protocol messages —
// all on its own, without any JS orchestration in the caller.
//
// Tools registered:
//   swarm_join            join a named Hyperswarm topic (returns swarmId)
//   swarm_broadcast       send a message to all connected peers
//   swarm_messages        read buffered incoming messages
//   swarm_peers           list currently connected peer keys
//   swarm_close           leave a topic and close connections
//
//   dht_serve             start a HyperDHT server, get a stable public key
//   dht_server_messages   read messages received by the server
//   dht_close_server      stop the server
//
//   dht_connect           connect to a DHT server by public key
//   dht_send              send a message over a connection
//   dht_messages          read buffered replies
//   dht_close_conn        close a connection
//
//   key_info              describe a key in z32, hex, and byte-length
//   codec_encode          encode a value with a compact-encoding codec file
//   codec_decode          decode hex bytes with a compact-encoding codec file

const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const b4a = require('b4a')
const z32 = require('z32')
const cenc = require('compact-encoding')
const { createHash } = require('bare-crypto')

// ─── internal helpers ─────────────────────────────────────────────────────────

const toZ32 = (buf) => z32.encode(b4a.isBuffer(buf) ? buf : b4a.from(buf))
const fromZ32 = (str) => b4a.from(z32.decode(str))
const toHex = (buf) => b4a.toString(buf, 'hex')
const fromHex = (str) => b4a.from(str, 'hex')

function topicFromName(name) {
  return createHash('sha256').update(name).digest()
}

function parseKey(str) {
  if (/^[a-z2-7]{52}$/.test(str)) return fromZ32(str)
  if (/^[0-9a-f]{64}$/i.test(str)) return fromHex(str)
  throw new Error(`invalid key — expected 52-char z32 or 64-char hex, got: ${str.slice(0, 20)}…`)
}

function encodeWith(codec, value) {
  const state = cenc.state()
  codec.preencode(state, value)
  state.buffer = b4a.allocUnsafe(state.end)
  state.start = 0
  codec.encode(state, value)
  return state.buffer
}

function decodeWith(codec, buf) {
  return codec.decode(cenc.decode.state(buf))
}

// Wire format for swarm/DHT text messages: { from: string, text: string }
const msgCodec = {
  preencode(state, m) {
    cenc.utf8.preencode(state, m.from)
    cenc.utf8.preencode(state, m.text)
  },
  encode(state, m) {
    cenc.utf8.encode(state, m.from)
    cenc.utf8.encode(state, m.text)
  },
  decode(state) {
    return { from: cenc.utf8.decode(state), text: cenc.utf8.decode(state) }
  }
}

function tryDecode(data, fallbackKey) {
  try {
    return decodeWith(msgCodec, data)
  } catch {
    return { from: fallbackKey.slice(0, 12) + '…', text: b4a.toString(data) }
  }
}

// ─── register ─────────────────────────────────────────────────────────────────

async function registerP2PTools(bc) {
  // open resources keyed by auto-incremented ID
  const swarms = new Map() // id → { swarm, topic, inbox: [] }
  const servers = new Map() // id → { dht, server, keyPair, inbox: [] }
  const conns = new Map() // id → { socket, dht, inbox: [] }
  let seq = 0
  const nextId = () => String(++seq)

  // ── Hyperswarm ──────────────────────────────────────────────────────────────

  await bc.registerTool(
    'swarm_join',
    'Join a named P2P topic on Hyperswarm. Every peer that knows the topic name ' +
      'connects directly — no server, no broker. Returns a swarmId to use with the ' +
      'other swarm_ tools. Incoming messages are buffered; call swarm_messages to read them.',
    {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Human-readable topic name, e.g. "brainstorm-v1"' }
      },
      required: ['topic'],
      additionalProperties: false
    },
    async ({ topic }) => {
      const id = nextId()
      const swarm = new Hyperswarm()
      const buf = topicFromName(topic)
      const inbox = []

      swarm.on('connection', (conn, info) => {
        const peerKey = toZ32(info.publicKey)
        conn.on('error', () => {})
        conn.on('data', (data) =>
          inbox.push({
            ...tryDecode(data, peerKey),
            time: Date.now()
          })
        )
      })

      await swarm.join(buf, { server: true, client: true }).flushed()
      swarms.set(id, { swarm, topic, inbox })

      return {
        swarmId: id,
        topic,
        publicKey: toZ32(swarm.keyPair.publicKey),
        peers: swarm.connections.size
      }
    }
  )

  await bc.registerTool(
    'swarm_broadcast',
    'Send a text message to every peer currently connected on a Hyperswarm topic. ' +
      'Returns the number of peers the message was delivered to.',
    {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'ID returned by swarm_join' },
        from: { type: 'string', description: 'Sender label (your name, agent ID, etc.)' },
        message: { type: 'string', description: 'Text to broadcast' }
      },
      required: ['swarmId', 'from', 'message'],
      additionalProperties: false
    },
    async ({ swarmId, from, message }) => {
      const entry = swarms.get(swarmId)
      if (!entry) return { error: `unknown swarmId: ${swarmId}` }
      const data = encodeWith(msgCodec, { from, text: message })
      let count = 0
      for (const conn of entry.swarm.connections) {
        conn.write(data)
        count++
      }
      return { delivered: count }
    }
  )

  await bc.registerTool(
    'swarm_messages',
    'Read (and clear) all messages that have arrived on a Hyperswarm topic since the last call.',
    {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'ID returned by swarm_join' }
      },
      required: ['swarmId'],
      additionalProperties: false
    },
    async ({ swarmId }) => {
      const entry = swarms.get(swarmId)
      if (!entry) return { error: `unknown swarmId: ${swarmId}` }
      const messages = entry.inbox.splice(0)
      return { messages, count: messages.length }
    }
  )

  await bc.registerTool(
    'swarm_peers',
    'List the public keys of peers currently connected on a Hyperswarm topic.',
    {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'ID returned by swarm_join' }
      },
      required: ['swarmId'],
      additionalProperties: false
    },
    async ({ swarmId }) => {
      const entry = swarms.get(swarmId)
      if (!entry) return { error: `unknown swarmId: ${swarmId}` }
      const peers = []
      for (const conn of entry.swarm.connections) {
        if (conn.remotePublicKey) peers.push(toZ32(conn.remotePublicKey))
      }
      return { peers, count: peers.length }
    }
  )

  await bc.registerTool(
    'swarm_close',
    'Leave a Hyperswarm topic and close all peer connections.',
    {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'ID returned by swarm_join' }
      },
      required: ['swarmId'],
      additionalProperties: false
    },
    async ({ swarmId }) => {
      const entry = swarms.get(swarmId)
      if (!entry) return { error: `unknown swarmId: ${swarmId}` }
      await entry.swarm.destroy()
      swarms.delete(swarmId)
      return { closed: true, topic: entry.topic }
    }
  )

  // ── HyperDHT server ─────────────────────────────────────────────────────────

  await bc.registerTool(
    'dht_serve',
    'Start a HyperDHT server with a stable public key. Unlike a Hyperswarm topic ' +
      '(where peers find each other anonymously), a DHT server has a known address — ' +
      'clients connect directly to it by public key, with full Noise-protocol encryption. ' +
      'Returns a serverId and the publicKey to share with clients. Incoming messages are ' +
      'buffered; call dht_server_messages to read them.',
    {
      type: 'object',
      properties: {
        seed: {
          type: 'string',
          description:
            'Optional seed for a deterministic keypair (same seed → same key across runs). Omit for a fresh random key.'
        }
      },
      additionalProperties: false
    },
    async ({ seed } = {}) => {
      const id = nextId()
      const keyPair = seed
        ? HyperDHT.keyPair(createHash('sha256').update(seed).digest())
        : HyperDHT.keyPair()
      const dht = new HyperDHT()
      const inbox = []

      const server = dht.createServer((socket) => {
        const remoteKey = toZ32(socket.remotePublicKey)
        socket.on('error', () => {})
        socket.on('data', (data) =>
          inbox.push({
            ...tryDecode(data, remoteKey),
            remoteKey,
            time: Date.now()
          })
        )
      })

      await server.listen(keyPair)
      servers.set(id, { dht, server, keyPair, inbox })

      return {
        serverId: id,
        publicKey: toZ32(keyPair.publicKey)
      }
    }
  )

  await bc.registerTool(
    'dht_server_messages',
    'Read (and clear) all messages received by a HyperDHT server since the last call.',
    {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'ID returned by dht_serve' }
      },
      required: ['serverId'],
      additionalProperties: false
    },
    async ({ serverId }) => {
      const entry = servers.get(serverId)
      if (!entry) return { error: `unknown serverId: ${serverId}` }
      const messages = entry.inbox.splice(0)
      return { messages, count: messages.length }
    }
  )

  await bc.registerTool(
    'dht_close_server',
    'Stop a HyperDHT server and tear down its DHT node.',
    {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'ID returned by dht_serve' }
      },
      required: ['serverId'],
      additionalProperties: false
    },
    async ({ serverId }) => {
      const entry = servers.get(serverId)
      if (!entry) return { error: `unknown serverId: ${serverId}` }
      await entry.server.close()
      await entry.dht.destroy()
      servers.delete(serverId)
      return { closed: true }
    }
  )

  // ── HyperDHT client ─────────────────────────────────────────────────────────

  await bc.registerTool(
    'dht_connect',
    'Connect to a HyperDHT server by its public key (z32 or hex). Returns a connId ' +
      'for sending messages. Replies are buffered; call dht_messages to read them.',
    {
      type: 'object',
      properties: {
        publicKey: { type: 'string', description: 'Server public key — 52-char z32 or 64-char hex' }
      },
      required: ['publicKey'],
      additionalProperties: false
    },
    async ({ publicKey }) => {
      const id = nextId()
      const key = parseKey(publicKey)
      const dht = new HyperDHT()
      const socket = dht.connect(key)
      const inbox = []

      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })

      socket.on('error', () => {})
      socket.on('data', (data) => {
        const remoteKey = toZ32(socket.remotePublicKey)
        inbox.push({ ...tryDecode(data, remoteKey), time: Date.now() })
      })

      socket._dht = dht
      conns.set(id, { socket, dht, inbox })

      return {
        connId: id,
        serverKey: toZ32(socket.remotePublicKey)
      }
    }
  )

  await bc.registerTool(
    'dht_send',
    'Send a text message over an established HyperDHT connection.',
    {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'ID returned by dht_connect' },
        from: { type: 'string', description: 'Sender label' },
        message: { type: 'string', description: 'Text to send' }
      },
      required: ['connId', 'from', 'message'],
      additionalProperties: false
    },
    async ({ connId, from, message }) => {
      const entry = conns.get(connId)
      if (!entry) return { error: `unknown connId: ${connId}` }
      entry.socket.write(encodeWith(msgCodec, { from, text: message }))
      return { sent: true }
    }
  )

  await bc.registerTool(
    'dht_messages',
    'Read (and clear) all replies received on a HyperDHT client connection since the last call.',
    {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'ID returned by dht_connect' }
      },
      required: ['connId'],
      additionalProperties: false
    },
    async ({ connId }) => {
      const entry = conns.get(connId)
      if (!entry) return { error: `unknown connId: ${connId}` }
      const messages = entry.inbox.splice(0)
      return { messages, count: messages.length }
    }
  )

  await bc.registerTool(
    'dht_close_conn',
    'Close a HyperDHT client connection and tear down its DHT node.',
    {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'ID returned by dht_connect' }
      },
      required: ['connId'],
      additionalProperties: false
    },
    async ({ connId }) => {
      const entry = conns.get(connId)
      if (!entry) return { error: `unknown connId: ${connId}` }
      entry.socket.destroy()
      await entry.dht.destroy()
      conns.delete(connId)
      return { closed: true }
    }
  )

  // ── Key utilities ────────────────────────────────────────────────────────────

  await bc.registerTool(
    'key_info',
    'Describe a cryptographic key in both z-base-32 and hex, with byte length. ' +
      'Accepts either format as input. Useful for converting keys between display formats ' +
      'or verifying a key before sharing it.',
    {
      type: 'object',
      properties: {
        key: { type: 'string', description: '52-char z32 or 64-char hex key' }
      },
      required: ['key'],
      additionalProperties: false
    },
    async ({ key }) => {
      try {
        const buf = parseKey(key)
        return { z32: toZ32(buf), hex: toHex(buf), bytes: buf.byteLength }
      } catch (err) {
        return { error: err.message }
      }
    }
  )

  // ── compact-encoding ────────────────────────────────────────────────────────

  await bc.registerTool(
    'codec_encode',
    'Encode a JSON value to binary using a compact-encoding codec loaded from a JS file. ' +
      'Returns the result as hex. Useful for constructing typed protocol messages or ' +
      'inspecting exactly what goes on the wire. ' +
      'The codec file must export: module.exports = { preencode, encode, decode }.',
    {
      type: 'object',
      properties: {
        codecFile: { type: 'string', description: 'Path to the codec module' },
        data: { description: "Value to encode — must match the codec's expected shape" }
      },
      required: ['codecFile', 'data'],
      additionalProperties: false
    },
    async ({ codecFile, data }) => {
      try {
        const mod = require(codecFile)
        const codec =
          mod.codec ||
          (mod.preencode ? mod : Object.values(mod).find((v) => v?.encode && v?.decode))
        if (!codec) return { error: `${codecFile}: no valid codec found` }
        const buf = encodeWith(codec, data)
        return { hex: toHex(buf), bytes: buf.byteLength }
      } catch (err) {
        return { error: err.message }
      }
    }
  )

  await bc.registerTool(
    'codec_decode',
    'Decode a hex-encoded binary buffer using a compact-encoding codec loaded from a JS file. ' +
      'Returns the decoded value as JSON. ' +
      'The codec file must export: module.exports = { preencode, encode, decode }.',
    {
      type: 'object',
      properties: {
        codecFile: { type: 'string', description: 'Path to the codec module' },
        hex: { type: 'string', description: 'Hex-encoded bytes to decode' }
      },
      required: ['codecFile', 'hex'],
      additionalProperties: false
    },
    async ({ codecFile, hex }) => {
      try {
        const mod = require(codecFile)
        const codec =
          mod.codec ||
          (mod.preencode ? mod : Object.values(mod).find((v) => v?.encode && v?.decode))
        if (!codec) return { error: `${codecFile}: no valid codec found` }
        return { data: decodeWith(codec, fromHex(hex)) }
      } catch (err) {
        return { error: err.message }
      }
    }
  )
}

module.exports = registerP2PTools
