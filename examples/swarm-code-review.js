// Multi-agent code review over P2P, with consensus. Each category is reviewed
// by TWO independent agents — so we can see where small models agree (high
// confidence) vs diverge (noise) — and a separate correlator agent ingests the
// whole panel over a HyperDHT hub and weighs the findings by agreement.
//
//   bare examples/swarm-code-review.js
//
// The hub (leader) reads the diff once and PUSHES it to each reviewer over the
// DHT, so the agents need no repo of their own — this works unchanged whether
// they're in this process or on other machines. Reviewers bring their own lens;
// only findings travel back. Fan out → correlate by agreement → one verdict.
//
// Reviews `BASE...HEAD` (falls back to the last commit). The local llama3.2
// default is noisy on its own — which is the whole point of doubling up and
// correlating; swap a capable model into OPTS for a genuinely sharp review.

const DHT = require('hyperdht')
const Corestore = require('corestore')
const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const { spawn } = require('bare-subprocess')
const { Bareclaw } = require('..')

const REPO = path.join(__dirname, '..')
const OUT = path.join(REPO, 'review.md')
const BASE = 'main'
const MAX_DIFF = 6000 // keep the prompt within a small model's context
const PER_CATEGORY = 1 // independent reviewers per lens, for consensus
const OPTS = { provider: 'ollama', model: 'llama3.2' }

const CATEGORIES = [
  { name: 'bugs', lens: 'correctness & bugs: logic errors, edge cases, races, resource leaks' },
  {
    name: 'security',
    lens: 'security: unsafe input handling, injection, privilege, leaked secrets'
  },
  { name: 'design', lens: 'API design & readability: naming, public surface, maintainability' },
  {
    name: 'quality',
    lens:
      'code quality, Unix philosophy: correct and clean structure, small single-purpose ' +
      'functions that do one thing well, composability, no dead code or needless complexity, ' +
      'consistent style — hold the change to a high craftsmanship bar'
  }
]

// Two reviewers per category: bugs#1, bugs#2, security#1, …
const SPECS = CATEGORIES.flatMap((c) =>
  Array.from({ length: PER_CATEGORY }, (_, i) => ({
    category: c.name,
    lens: c.lens,
    from: `${c.name}#${i + 1}`
  }))
)

main()

async function main() {
  const diff = await loadDiff()
  if (!diff) return console.log('nothing to review (empty diff)')
  console.log(
    `🔍 reviewing ${diff.length} chars vs ${BASE} — ` +
      `${CATEGORIES.length} lenses × ${PER_CATEGORY} agents = ${SPECS.length} reviewers + 1 correlator\n`
  )

  // ---- HyperDHT hub: collects reviews, fans the board out to every client ----
  const hubNode = new DHT()
  const keyPair = DHT.keyPair(b4a.alloc(32, 'bareclaw:code-review:hub'))
  const conns = new Set()
  const reviews = []
  let correlation = null
  let resolveAllIn, resolveCorrelated
  const allIn = new Promise((r) => (resolveAllIn = r))
  const correlated = new Promise((r) => (resolveCorrelated = r))

  const broadcast = () => {
    const payload = { type: 'board', reviews }
    for (const c of conns) writeJSON(c, payload)
  }

  const server = hubNode.createServer((socket) => {
    conns.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => conns.delete(socket))
    writeJSON(socket, { type: 'task', diff }) // leader pushes the work — remote agents need no repo
    writeJSON(socket, { type: 'board', reviews }) // current state, for the correlator
    readJSON(socket, (msg) => {
      if (msg.type === 'review') {
        reviews.push(msg)
        console.log(`📥 ${msg.from} filed a review (${reviews.length}/${SPECS.length})`)
        broadcast()
        if (reviews.length === SPECS.length) resolveAllIn()
      } else if (msg.type === 'correlation') {
        correlation = msg.text
        resolveCorrelated()
      }
    })
  })
  await server.listen(keyPair)

  // ---- the panel: redundant reviewers; each gets the diff pushed by the hub ----
  const reviewers = await Promise.all(SPECS.map((spec) => runReviewer(spec, keyPair.publicKey)))
  await allIn

  // ---- the correlator: pulls the full board off the hub, weighs agreement ----
  const correlator = await runCorrelator(keyPair.publicKey)
  await correlated

  // ---- report ----
  // Two computed views (no reliance on model prose): a consensus table and an
  // attributed action list. Full findings + verdict go to the handoff file.
  console.log('\n===== consensus =====')
  for (const row of summarize(reviews)) console.log('  ' + row.line)

  const items = actionItems(reviews)
  console.log('\n===== action items =====')
  if (!items.length) console.log('  (none — all lenses clear)')
  for (const it of items) console.log(`  • [${it.from}] ${oneLine(it.text)}`)

  // Write a self-contained handoff file another LLM can pick up and act on.
  fs.writeFileSync(OUT, renderReport(diff, reviews, correlation, items))
  console.log(`\n📝 full report → ${OUT}`)

  for (const r of reviewers) await r.cleanup()
  await correlator.cleanup()
  await server.close()
  await hubNode.destroy()
  console.log('\n✅ review complete')
}

async function runReviewer(spec, hubKey) {
  const agent = await makeAgent(spec.from)
  const node = new DHT()
  const socket = node.connect(hubKey)
  socket.on('error', () => {})

  // Wait for the hub to push the diff, then review with this agent's own lens.
  let reviewed = false
  readJSON(socket, (msg) => {
    if (msg.type !== 'task' || reviewed) return
    reviewed = true
    ask(agent.bc, agent.key, reviewPrompt(spec.lens, msg.diff)).then((review) => {
      console.log(`🧐 ${spec.from} finished`)
      writeJSON(socket, { type: 'review', category: spec.category, from: spec.from, review })
    })
  })

  return {
    cleanup: async () => {
      socket.destroy()
      await node.destroy()
      await agent.cleanup()
    }
  }
}

async function runCorrelator(hubKey) {
  const agent = await makeAgent('correlator')
  const node = new DHT()
  const socket = node.connect(hubKey)
  socket.on('error', () => {})

  let started = false
  readJSON(socket, (msg) => {
    if (msg.type !== 'board' || started || msg.reviews.length < SPECS.length) return
    started = true
    console.log('\n🔗 correlator received the full board, weighing agreement…')
    ask(agent.bc, agent.key, correlatePrompt(msg.reviews)).then((text) =>
      writeJSON(socket, { type: 'correlation', text })
    )
  })

  return {
    cleanup: async () => {
      socket.destroy()
      await node.destroy()
      await agent.cleanup()
    }
  }
}

async function makeAgent(name) {
  const store = new Corestore('./store-' + name)
  await store.ready()
  const bc = new Bareclaw(store, OPTS)
  await bc.ready()
  const key = await bc.session({ agentId: name, channel: 'review' })
  return {
    bc,
    key,
    cleanup: async () => {
      await bc.close()
      await store.close()
    }
  }
}

// Strip tool-call JSON lines a noisy small model may emit, leaving real prose.
function cleanReview(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*•\s]*[{[].*"\s*:/.test(l))
    .join('\n')
    .trim()
}

// Ways a reviewer says "nothing to fix" (small models phrase this many ways).
const PASS =
  /\b(lgtm|looks good|no (issues|findings|concerns|problems|changes needed)|none (found|to report)|nothing (to report|found|to flag))\b/i

// The real finding in a review (JSON noise removed), or null if the reviewer
// effectively passed. This single signal drives both the consensus table and
// the action list, so they never disagree.
function findings(review) {
  const t = cleanReview(review)
  if (!t) return null
  const hasBullets = /(^|\n)\s*[-*•]/.test(t)
  if (!hasBullets && PASS.test(t)) return null
  return t
}

function isClean(review) {
  return findings(review) === null
}

function oneLine(text) {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 100 ? s.slice(0, 100) + '…' : s
}

// Deterministic action list: every real finding, attributed to the agent that
// raised it. Independent of the correlator's prose.
function actionItems(reviews) {
  const items = []
  for (const r of reviews) {
    const text = findings(r.review)
    if (text) items.push({ category: r.category, from: r.from, text })
  }
  return items
}

// Per-category consensus across its PER_CATEGORY reviewers.
function summarize(reviews) {
  return CATEGORIES.map((c) => {
    const rs = reviews.filter((r) => r.category === c.name)
    const clean = rs.filter((r) => isClean(r.review)).length
    const total = rs.length
    let icon, status
    if (total && clean === total) [icon, status] = ['✓', 'clean']
    else if (clean === 0) [icon, status] = ['⚠', 'issues']
    else [icon, status] = ['~', 'mixed']
    const line = `${icon} ${c.name.padEnd(9)} ${status.padEnd(7)} (${clean}/${total} agree clean)`
    return { category: c.name, clean, total, status, line }
  })
}

// A self-contained markdown handoff: action items + consensus + panel findings
// + the reviewed diff, so a downstream LLM has everything it needs to fix.
function renderReport(diff, reviews, correlation, items) {
  const consensus = summarize(reviews)
    .map((r) => `| ${r.category} | ${r.status} | ${r.clean}/${r.total} clean |`)
    .join('\n')

  const actions = items.length
    ? items
        .map((it) => `- **[${it.category}/${it.from}]** ${it.text.replace(/\n+/g, ' ')}`)
        .join('\n')
    : '_No action items — every lens came back clean._'

  const panel = CATEGORIES.map((c) => {
    const entries = reviews
      .filter((r) => r.category === c.name)
      .map((r) => `#### ${r.from}\n\n${cleanReview(r.review) || '_LGTM_'}`)
      .join('\n\n')
    return `### ${c.name}\n\n${entries}`
  }).join('\n\n')

  const verdict = cleanReview(correlation)

  return (
    `# Code Review — \`${BASE}...HEAD\`\n\n` +
    `Produced by a bareclaw multi-agent panel (${CATEGORIES.length} lenses × ` +
    `${PER_CATEGORY} agents) with a correlator. Action the items below, most important first.\n\n` +
    `## Action items\n\n${actions}\n\n` +
    `## Consensus\n\n| lens | status | agreement |\n| --- | --- | --- |\n${consensus}\n\n` +
    (verdict ? `## Correlator notes\n\n${verdict}\n\n` : '') +
    `## Panel findings\n\n${panel}\n\n` +
    `## Reviewed diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`
  )
}

function reviewPrompt(lens, diff) {
  return (
    `You are a code reviewer focused on ${lens}.\n` +
    `Review this diff and list the 1-3 most important findings as short bullets ` +
    `(file + issue). If you find nothing in your area, reply "LGTM".\n\n` +
    `DIFF:\n${diff}`
  )
}

function correlatePrompt(reviews) {
  const byCat = {}
  for (const r of reviews) (byCat[r.category] ||= []).push(r)
  const block = Object.entries(byCat)
    .map(([cat, rs]) => `## ${cat}\n` + rs.map((r) => `[${r.from}] ${r.review}`).join('\n'))
    .join('\n\n')
  return (
    `You are the lead reviewer correlating a panel. Each category was reviewed by ` +
    `${PER_CATEGORY} independent agents. Cross-check them: mark a finding CONFIRMED when ` +
    `agents in the same category agree, TENTATIVE when only one raised it. Then give a ` +
    `short overall verdict. Be concise.\n\n` +
    block
  )
}

async function ask(bc, key, message) {
  let out = ''
  for await (const chunk of bc.chat(key, message)) {
    if (chunk.type === 'content') out += chunk.content
    if (chunk.done) break
  }
  return out.trim() || '(no response)'
}

// Pull the diff via git; fall back to the last commit if BASE...HEAD is empty.
function loadDiff() {
  return new Promise((resolve) => {
    git(['diff', `${BASE}...HEAD`], (out) => {
      if (out.trim()) return resolve(cap(out))
      git(['diff', 'HEAD~1', 'HEAD'], (o2) => resolve(cap(o2)))
    })
  })
}

function git(args, cb) {
  const proc = spawn('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  proc.stdout.on('data', (d) => (out += b4a.toString(d)))
  proc.on('exit', () => cb(out))
}

function cap(s) {
  s = s.trim()
  return s.length > MAX_DIFF ? s.slice(0, MAX_DIFF) + '\n…(diff truncated)' : s
}

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
