// One-to-many sharing through a HyperDHT server. A single "hub" node listens on
// a public key; many agents connect to it as clients, each posting one idea.
// The hub merges every contribution and broadcasts the shared board back to all
// of them — a tiny distributed blackboard, no server infrastructure.
//
//   bare examples/dht-shared.js
//
// Hyperswarm (topic-based, many-to-many discovery) is great for "find peers";
// a HyperDHT server is the right tool when you want a known rendezvous that
// fans shared state out to N clients.

const DHT = require('hyperdht')
const Corestore = require('corestore')
const b4a = require('b4a')
const { Bareclaw } = require('..')

const AGENTS = ['scout', 'maker', 'critic']
const PROMPT =
  'Give ONE short feature idea for a peer-to-peer notes app. Max 10 words, no preamble.'

main()

async function main() {
  // ---- the hub: a HyperDHT server collecting + broadcasting the board ----
  const hubNode = new DHT()
  const keyPair = DHT.keyPair(b4a.alloc(32, 'bareclaw:dht-shared:hub'))
  const board = []
  const conns = new Set()

  const server = hubNode.createServer((socket) => {
    conns.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => conns.delete(socket))
    readJSON(socket, (msg) => {
      if (msg.type !== 'post') return
      board.push({ from: msg.from, text: msg.text })
      console.log(`🗒️  hub received from ${msg.from}: ${msg.text}`)
      const payload = { type: 'board', items: board }
      for (const c of conns) writeJSON(c, payload) // fan out to everyone
    })
  })
  await server.listen(keyPair)
  console.log('📡 hub listening on', b4a.toString(keyPair.publicKey, 'hex').slice(0, 16) + '…\n')

  // ---- the agents: each generates an idea and posts it to the hub ----
  const results = await Promise.all(
    AGENTS.map((name) => runAgent(name, keyPair.publicKey, AGENTS.length))
  )

  console.log('\n📋 final shared board (as every agent saw it):')
  for (const item of results[0].board) console.log(`   • ${item.from}: ${item.text}`)

  for (const r of results) await r.cleanup()
  await server.close()
  await hubNode.destroy()
  console.log('\n✅ done — board shared across', AGENTS.length, 'agents via one DHT server')
}

async function runAgent(name, hubKey, expected) {
  const store = new Corestore('./store-' + name)
  await store.ready()
  const bc = new Bareclaw(store, { provider: 'ollama', model: 'llama3.2' })
  await bc.ready()

  const key = await bc.session({ agentId: name, channel: 'ideas' })
  const idea = await ask(bc, key, PROMPT)
  console.log(`💡 ${name} thought of: ${idea}`)

  const node = new DHT()
  const socket = node.connect(hubKey)

  let resolveBoard
  const gotFullBoard = new Promise((r) => (resolveBoard = r))
  let latest = []
  socket.on('error', () => {})
  readJSON(socket, (msg) => {
    if (msg.type === 'board') {
      latest = msg.items
      if (latest.length >= expected) resolveBoard(latest)
    }
  })

  socket.once('open', () => writeJSON(socket, { type: 'post', from: name, text: idea }))

  const board = await gotFullBoard
  return {
    board,
    cleanup: async () => {
      socket.destroy()
      await node.destroy()
      await bc.close()
      await store.close()
    }
  }
}

async function ask(bc, key, message) {
  let out = ''
  for await (const chunk of bc.chat(key, message)) {
    if (chunk.type === 'content') out += chunk.content
    if (chunk.done) break
  }
  return out.trim().split('\n')[0] || '(no idea)'
}

// newline-delimited JSON over a NoiseSecretStream
function readJSON(socket, fn) {
  let buf = ''
  socket.on('data', (data) => {
    buf += b4a.toString(data)
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line) fn(JSON.parse(line))
    }
  })
}

function writeJSON(socket, obj) {
  socket.write(b4a.from(JSON.stringify(obj) + '\n'))
}
