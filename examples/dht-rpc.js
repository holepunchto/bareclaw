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

const { Bareclaw } = require('..')
const registerP2PTools = require('./tools/p2p')

const TOPIC = b4a.alloc(32, 'bareclaw:p2p-demo:v1')
const DECOYS = 3
const WAIT_MS = 3000

main()

async function main() {
  // Stand up decoy peers so the agent finds a real crowd when it joins.
  const decoys = []
  for (let i = 0; i < DECOYS; i++) {
    const s = new Hyperswarm()
    s.on('connection', (conn) => {
      conn.on('error', () => {})
      // Decoys echo back a short reply so swarm_messages has something to show.
      conn.on('data', () => conn.write(b4a.from(`decoy-${i}: 👋 hello from the mesh`)))
    })
    s.join(TOPIC, { server: true, client: true })
    decoys.push(s)
  }
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
  const prompt = `You have access to P2P networking tools. Please do the following steps in order:
1. Join the Hyperswarm topic named "bareclaw:p2p-demo:v1" using swarm_join.
2. Wait a moment, then check how many peers are connected with swarm_peers.
3. Broadcast the message "hello from the AI agent" from "agent" using swarm_broadcast.
4. Wait ${WAIT_MS / 1000} seconds, then read any incoming messages with swarm_messages.
5. Close the swarm with swarm_close.
Report what you found at each step.`

  console.log('📋 prompt:', prompt, '\n')

  let reply = ''
  for await (const chunk of bc.chat(key, prompt)) {
    if (chunk.type === 'content') {
      process.stdout.write(chunk.content)
      reply += chunk.content
    }
    if (chunk.done) break
  }
  console.log('\n')

  await bc.close()
  await store.close()
  for (const s of decoys) await s.destroy()
  console.log('✅ done')
}
