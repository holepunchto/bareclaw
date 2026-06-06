// Two bareclaw agents meet on a Hyperswarm topic and collaborate by relaying
// turns: each one feeds the partner's last message into its own picoclaw agent
// and replies, building a shared plan together.
//
//   bare examples/swarm-collab.js
//
// Both agents run here in one process, but each has its own Corestore + its own
// Hyperswarm instance, so they genuinely discover and connect over the DHT —
// exactly as two agents on two machines would.

const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const b4a = require('b4a')
const { Bareclaw } = require('..')

const TOPIC = b4a.alloc(32, 'bareclaw:swarm-collab:v1')
const ROUNDS = 3 // turns per agent
const MAX = ROUNDS * 2 // total messages before both agents wrap up
const TASK = 'plan a fun community hackathon'

// Everything the Go agent needs is passed straight through `opts` on Bareclaw.
const OPTS = { provider: 'ollama', model: 'llama3.2' }

main()

async function main() {
  const alice = await makeAgent('alice', 'the visionary who proposes bold ideas')
  const bob = await makeAgent('bob', 'the pragmatist who sharpens and grounds ideas')

  // alice opens the conversation once a peer shows up.
  let started = false
  alice.swarm.on('connection', (socket) => {
    wire(alice, socket)
    if (!started) {
      started = true
      console.log('\n🔗 agents connected — collaborating on: ' + TASK + '\n')
      turn(alice, socket, null, 1)
    }
  })
  bob.swarm.on('connection', (socket) => wire(bob, socket))

  console.log('🐝 joining swarm, waiting for agents to find each other…')
}

async function makeAgent(name, persona) {
  const store = new Corestore('./store-' + name)
  await store.ready()
  const bc = new Bareclaw(store, OPTS)
  await bc.ready()
  const key = await bc.session({ agentId: name, channel: 'collab' })
  const swarm = new Hyperswarm()
  swarm.join(TOPIC, { server: true, client: true })
  return { name, persona, bc, key, swarm, store, done: false }
}

// Read newline-delimited JSON frames off a connection.
function wire(agent, socket) {
  let buf = ''
  socket.on('data', (data) => {
    buf += b4a.toString(data)
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line) onMessage(agent, socket, JSON.parse(line))
    }
  })
  socket.on('error', () => {})
}

async function onMessage(agent, socket, msg) {
  if (agent.done) return
  console.log(`💬 ${msg.from} → ${agent.name} (round ${msg.round}): ${msg.text}`)
  await turn(agent, socket, msg, msg.round + 1)
}

async function turn(agent, socket, incoming, round) {
  if (round > MAX) return finish(agent)

  const prompt = incoming
    ? `You are ${agent.persona}, co-planning "${TASK}" with another AI.\n` +
      `Your partner just said: "${incoming.text}"\n` +
      `Reply with ONE concrete idea or improvement that builds on it. Max 2 sentences.`
    : `You are ${agent.persona}. Kick off planning "${TASK}" with ONE opening idea. Max 2 sentences.`

  const text = await ask(agent, prompt)
  console.log(`🗣️  ${agent.name}: ${text}\n`)
  send(socket, { from: agent.name, round, text })

  if (round >= MAX) finish(agent)
}

async function ask(agent, message) {
  let out = ''
  for await (const chunk of agent.bc.chat(agent.key, message)) {
    if (chunk.type === 'content') out += chunk.content
    if (chunk.done) break
  }
  return out.trim() || '(no response)'
}

function send(socket, obj) {
  socket.write(b4a.from(JSON.stringify(obj) + '\n'))
}

let finished = 0
async function finish(agent) {
  if (agent.done) return
  agent.done = true
  await agent.bc.close()
  await agent.store.close()
  await agent.swarm.destroy()
  if (++finished === 2) {
    console.log('✅ collaboration complete — both agents left the swarm')
  }
}
