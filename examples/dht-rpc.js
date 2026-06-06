// Give a bareclaw agent the full P2P toolkit, then ask it to run a live
// Hyperswarm session: join a topic, find peers, broadcast a message, and
// read back whatever the mesh replies with.
//
// registerP2PTools hands the agent: swarm_join, swarm_broadcast,
// swarm_messages, swarm_peers, swarm_close, dht_serve, dht_connect,
// dht_send, dht_messages, key_info, codec_encode, codec_decode — the whole
// Holepunch stack as AI-callable tools.
//
//   bare examples/dht-rpc.js

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const b4a = require('b4a')
const process = require('bare-process')
const { createHash } = require('bare-crypto')

const { Bareclaw } = require('..')
const registerP2PTools = require('./tools/p2p')

// Must match topicFromName() in tools/p2p.js — SHA-256 of the name string.
const TOPIC_NAME = 'bareclaw:p2p-demo:v1'
const TOPIC = createHash('sha256').update(TOPIC_NAME).digest()
const DECOYS = 3
const WAIT_MS = 3000

main()

async function main () {
  // Stand up decoy peers and flush them to the DHT before the agent starts.
  const decoys = []
  for (let i = 0; i < DECOYS; i++) {
    const s = new Hyperswarm()
    s.on('connection', (conn) => {
      conn.on('error', () => {})
      // Reply to any message so swarm_messages has something to show.
      conn.on('data', () => conn.write(b4a.from(`decoy-${i}: 👋 hello from the mesh`)))
    })
    s.join(TOPIC, { server: true, client: true })
    decoys.push(s)
  }
  // Wait for all decoys to announce on the DHT before the agent looks for peers.
  await Promise.all(decoys.map((s) => s.flush()))
  console.log(`🐝 ${DECOYS} decoy peers are live on the topic\n`)

  // Spin up the agent and give it every P2P tool.
  const store = new Corestore('./store-p2p-agent')
  await store.ready()
  const bc = new Bareclaw(store, { provider: 'ollama', model: 'llama3.2' })
  await bc.ready()

  await registerP2PTools(bc)

  const key = await bc.session({ agentId: 'p2p-agent', channel: 'demo' })
  console.log('🤖 agent ready — tools registered\n')

  // Ask the agent to use its new P2P superpowers.
  const prompt =
    `You have access to P2P networking tools. Please do the following steps in order:\n` +
    `1. Join the Hyperswarm topic named "${TOPIC_NAME}" using swarm_join.\n` +
    `2. Check how many peers are connected with swarm_peers.\n` +
    `3. Broadcast the message "hello from the AI agent" from "agent" using swarm_broadcast.\n` +
    `4. Wait a moment, then read any replies with swarm_messages.\n` +
    `5. Close the swarm with swarm_close.\n` +
    `Report what you found at each step.`

  console.log('📋 prompt:', prompt, '\n')

  // Track whether the agent actually invoked any tool this turn.
  // (llama3.2 sometimes narrates instead of calling — see README note.)
  let agentCalledTools = false

  let reply = ''
  for await (const chunk of bc.chat(key, prompt)) {
    if (chunk.type === 'content') {
      process.stdout.write(chunk.content)
      reply += chunk.content
    }
    if (chunk.type === 'tool_call') agentCalledTools = true
    if (chunk.done) break
  }
  console.log('\n')

  // Direct-call fallback: if the model didn't invoke tools, demonstrate the
  // P2P wiring works by scanning the topic ourselves — same proof as above.
  if (!agentCalledTools) {
    console.log('(model did not call tools — running direct-call fallback)\n')
    const found = await scanTopic(TOPIC, WAIT_MS)
    console.log(`🔧 direct scan → found ${found} peer(s) on "${TOPIC_NAME}"`)
    console.log('   (a capable model calls swarm_join/swarm_broadcast/etc. itself)\n')
  }

  await bc.close()
  await store.close()
  for (const s of decoys) await s.destroy()
  console.log('✅ done')
}

// Briefly join the topic as a client, count distinct peers found, then leave.
async function scanTopic (topic, ms) {
  const swarm = new Hyperswarm()
  const seen = new Set()
  swarm.on('connection', (socket, info) => {
    seen.add(b4a.toString(info.publicKey, 'hex'))
    socket.on('error', () => {})
  })
  swarm.join(topic, { server: false, client: true })
  await swarm.flush()
  await new Promise((r) => setTimeout(r, ms))
  await swarm.destroy()
  return seen.size
}
