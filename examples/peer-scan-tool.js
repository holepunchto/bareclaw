// Give a bareclaw agent a P2P superpower: a `scan_peers` tool that joins a
// Hyperswarm topic, counts how many peers it finds within a short window, then
// leaves. This is the key idea behind `registerTool` — the Go agent calls back
// into JS, and JS-in-Bare has the whole Holepunch stack at hand.
//
//   bare examples/peer-scan-tool.js
//
// We stand up a few "decoy" peers on the topic so there's a crowd to discover.

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const b4a = require('b4a')
const { Bareclaw } = require('..')

const LOBBY = b4a.alloc(32, 'bareclaw:lobby:v1')
const SCAN_MS = 4000
const DECOYS = 3

main()

async function main() {
  // 1. Populate the lobby with decoy peers (no agents, just swarm members).
  const decoys = []
  for (let i = 0; i < DECOYS; i++) {
    const s = new Hyperswarm()
    s.on('connection', (sock) => sock.on('error', () => {}))
    s.join(LOBBY, { server: true, client: true })
    decoys.push(s)
  }
  console.log(`🐝 ${DECOYS} decoy peers are sitting in the lobby`)

  // 2. Spin up an agent and hand it the scan_peers tool.
  const store = new Corestore('./store-scanner')
  await store.ready()
  const bc = new Bareclaw(store, { provider: 'ollama', model: 'llama3.2' })
  await bc.ready()

  let lastCount = null
  await bc.registerTool(
    'scan_peers',
    'Join the P2P lobby, count how many peers are currently online, then leave. Returns the count.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      lastCount = await scanPeers(LOBBY, SCAN_MS)
      console.log(`🔧 scan_peers ran → found ${lastCount} peer(s)`)
      return { peers: lastCount }
    }
  )

  // 3. Ask the agent to use it.
  const key = await bc.session({ agentId: 'scanner', channel: 'ops' })
  console.log('\n🤖 asking the agent to scan the lobby…\n')
  let answer = ''
  for await (const chunk of bc.chat(
    key,
    'Use the scan_peers tool to find how many peers are online right now, then tell me just the number.'
  )) {
    if (chunk.type === 'content') answer += chunk.content
    if (chunk.done) break
  }
  console.log('🗣️  agent:', answer.trim() || '(no text)')

  // Ground-truth fallback so the capability is always demonstrated, even if a
  // small local model declined to call the tool.
  if (lastCount === null) {
    const n = await scanPeers(LOBBY, SCAN_MS)
    console.log(`\n(direct call) scan_peers → ${n} peer(s) — capable models invoke this themselves`)
  }

  await bc.close()
  await store.close()
  for (const s of decoys) await s.destroy()
  console.log('\n✅ done')
}

// The actual tool logic: briefly join the swarm, tally distinct peers, leave.
async function scanPeers(topic, ms) {
  const swarm = new Hyperswarm()
  const seen = new Set()
  swarm.on('connection', (socket, info) => {
    seen.add(b4a.toString(info.publicKey, 'hex'))
    socket.on('error', () => {})
  })
  swarm.join(topic, { server: false, client: true })
  await swarm.flush() // wait for topic announce + first discovery round
  await sleep(ms)
  const count = seen.size
  await swarm.destroy()
  return count
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
