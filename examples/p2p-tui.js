// A terminal chat UI for a bareclaw agent that has the full P2P toolkit.
//
// This wires three things together:
//   • bareclaw      — the Go agent, streamed over RPC (index.js `chat()`)
//   • examples/tools/p2p.js — registers Hyperswarm / HyperDHT as agent tools
//   • bare-tui      — an Elm-architecture TUI (Program / update / view)
//
// You chat with the agent in a scrollable transcript; when it calls a P2P tool
// (swarm_join, swarm_broadcast, …) the call shows up live in the log. A handful
// of decoy peers sit on a known topic so there's a mesh to discover.
//
//   bare examples/p2p-tui.js
//
// Then try asking, e.g.:
//   Join the topic "bareclaw:tui-demo:v1", list the peers, broadcast
//   "hello from the TUI", wait a moment, then read any replies.

const Corestore = require('corestore')
const process = require('bare-process')
const { Program, quit, batch, style, key, viewport, textinput, spinner, help } = require('bare-tui')

const { Bareclaw } = require('..')
const registerP2PTools = require('./tools/p2p')

// Keybindings — also drive the help footer (key.binding hints render there).
const KEYS = {
  send: key.binding({ keys: ['enter'], help: { key: 'enter', desc: 'send' } }),
  scroll: key.binding({ keys: ['pgup', 'pgdn'], help: { key: 'pgup/pgdn', desc: 'scroll' } }),
  quit: key.binding({ keys: ['esc', 'ctrl+c'], help: { key: 'esc', desc: 'quit' } })
}

// Local Ollama model by default. lfm2.5 is small and built for tool calling;
// for more reliable tool use swap in a larger one (e.g. gpt-oss:20b).
const OPTS = { provider: 'ollama', model: 'lfm2.5' }

async function main() {
  // First CLI arg is the Corestore path, so you can run several agents at once,
  // each with its own store:  bare examples/p2p-tui.js ./store-a
  const storePath = process.argv[2] || './store-p2p-tui'

  // Render the TUI immediately; the agent boots lazily from init() so the user
  // sees the UI (and live progress) right away instead of a blank terminal.
  const app = new ChatApp({ storePath })
  const program = new Program(app)
  app.program = program // lets boot/tool callbacks inject messages into the loop
  await program.run() // resolves when the user quits (esc / ctrl+c)
  await app.shutdown()
}

// A Cmd that pulls one chunk off the chat stream and turns it into a Msg. The
// runtime feeds the Msg to update(), which re-issues pull() until the generator
// is exhausted — one chunk per tick keeps update() pure and the UI responsive.
function pull(gen) {
  return () => gen.next().then((r) => ({ type: 'chunk', done: r.done, chunk: r.value }))
}

class ChatApp {
  constructor({ storePath }) {
    this.program = null
    this.storePath = storePath

    // Resources, populated by _boot().
    this.bc = null
    this.key = null
    this.store = null

    this.ready = false
    this.bootStatus = 'starting…'

    this.entries = [{ role: 'system', text: 'Booting the P2P agent…' }]
    this.pending = '' // assistant text accumulating during a stream
    this.streaming = false
    this.gen = null

    this.width = 80
    this.height = 24
    this.input = textinput.create({ prompt: '› ', placeholder: 'message the agent…' })
    this.spinner = spinner.create({ fps: 12 })
    this.help = help.create()
    this.vp = viewport.create({ width: this._innerWidth(), height: this._bodyHeight() })
    this._refresh()
  }

  // Runs once at startup: animate the spinner and boot the agent off the update
  // path so the first frame paints immediately.
  init() {
    return batch(this.spinner.init(), () => this._boot())
  }

  update(msg) {
    switch (msg.type) {
      case 'status':
        this.bootStatus = msg.text
        return [this, null]

      case 'ready':
        this.ready = true
        this.input = this.input.focus()
        this.entries = [
          { role: 'system', text: 'Agent ready, with the full P2P toolkit registered.' },
          {
            role: 'system',
            text: 'Try: Join a Hyperswarm topic called "lobby", list the peers, then broadcast "hello". Or just chat.'
          }
        ]
        this._refresh()
        return [this, null]

      case 'resize':
        this.width = msg.width
        this.height = msg.height
        this.vp = viewport.create({ width: this._innerWidth(), height: this._bodyHeight() })
        this._refresh()
        return [this, null]

      case 'spinner.tick': {
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        // Keep the animation alive while booting or while a turn is in flight.
        return [this, !this.ready || this.streaming ? cmd : null]
      }

      case 'chunk':
        return this._onChunk(msg)

      case 'tool':
        this.entries.push({ role: 'tool', text: `${msg.name}(${compact(msg.input)})` })
        this._refresh()
        return [this, null]

      case 'error':
        this.entries.push({ role: 'system', text: `error: ${msg.error?.message || msg.error}` })
        this.streaming = false
        this._refresh()
        return [this, null]

      case 'key':
        return this._onKey(msg)

      default:
        return [this, null]
    }
  }

  view() {
    const W = this.width

    // Full-width title bar.
    const header = style()
      .bold()
      .foreground('black')
      .background('cyan')
      .width(W)
      .render(` 🐝 bareclaw P2P agent  ·  ${this.storePath}`)

    // Transcript inside a rounded border.
    const transcript = style()
      .border(style.borders.rounded)
      .borderForeground('blue')
      .padding(0, 1)
      .render(this.vp.view())

    // Status line: spinner + state while busy, keybinding help when idle.
    let status
    if (!this.ready) {
      status = `${this.spinner.view()} ${style()
        .faint(true)
        .render('booting — ' + this.bootStatus)}`
    } else if (this.streaming) {
      status = `${this.spinner.view()} ${style().foreground('yellow').render('agent is working…')}`
    } else {
      status = this.help.view([KEYS.send, KEYS.scroll, KEYS.quit])
    }

    // Input box — border lights up green once the agent is interactive.
    const inputBox = style()
      .border(style.borders.rounded)
      .borderForeground(this.ready ? 'green' : 'gray')
      .padding(0, 1)
      .width(this._innerWidth())
      .render(this.input.view())

    return style.joinVertical(style.position.left, header, transcript, ' ' + status, inputBox)
  }

  // ── message handlers ────────────────────────────────────────────────────────

  _onKey(msg) {
    if (msg.is('ctrl+c', 'esc')) return [this, quit]

    if (msg.is('pgup', 'pgdn', 'ctrl+u', 'ctrl+d')) {
      const [v] = this.vp.update(msg)
      this.vp = v
      return [this, null]
    }

    if (!this.ready || this.streaming) return [this, null] // ignore typing until idle

    if (msg.is('enter')) {
      const text = this.input.value.trim()
      if (!text) return [this, null]
      return this._submit(text)
    }

    const [inp, cmd] = this.input.update(msg)
    this.input = inp
    return [this, cmd]
  }

  _submit(text) {
    this.input = this.input.reset()
    this.entries.push({ role: 'user', text })
    this.pending = ''
    this.streaming = true
    this.gen = this.bc.chat(this.key, text)
    this._refresh()
    // Stream chunks and animate the spinner concurrently.
    return [this, batch(pull(this.gen), this.spinner.init())]
  }

  _onChunk(msg) {
    if (msg.done) {
      // Generator exhausted (history already persisted by chat()'s finally).
      this.streaming = false
      this.input = this.input.focus()
      this._refresh()
      return [this, null]
    }

    const c = msg.chunk
    if (c.type === 'content') this.pending += c.content
    else if (c.type === 'error') this.pending += '\n[stream error]'

    // 'done'/'error' end the turn's content — commit it as a finished entry and
    // stop the spinner, but keep pulling once more to let the generator finish.
    if (c.type === 'done' || c.type === 'error') {
      if (this.pending.trim()) this.entries.push({ role: 'assistant', text: this.pending.trim() })
      this.pending = ''
      this.streaming = false
    }

    this._refresh()
    return [this, pull(this.gen)]
  }

  // Inject a tool-call event into the loop. Called from the registerTool
  // wrapper, which fires off the update path while the chat stream is awaiting.
  notifyTool(name, input) {
    if (this.program) this.program.send({ type: 'tool', name, input })
  }

  // Push a boot-progress line into the status bar (sent, not returned, so it
  // shows up live as each async step completes).
  _status(text) {
    if (this.program) this.program.send({ type: 'status', text })
  }

  // Bring up the whole stack off the update path, reporting progress as it goes.
  // Resolves to the 'ready' Msg, which flips the UI into interactive mode.
  async _boot() {
    this._status('opening corestore…')
    this.store = new Corestore(this.storePath)
    await this.store.ready()

    this._status('spawning bareclaw agent…')
    this.bc = new Bareclaw(this.store, OPTS)
    await this.bc.ready()

    // Wrap registerTool so every P2P tool call is mirrored into the transcript
    // as it fires. registerP2PTools then registers through this wrapper.
    const register = this.bc.registerTool.bind(this.bc)
    this.bc.registerTool = (name, description, schema, handler) =>
      register(name, description, schema, (input) => {
        this.notifyTool(name, input)
        return handler(input)
      })

    this._status('registering P2P tools…')
    await registerP2PTools(this.bc)
    this.key = await this.bc.session({ agentId: 'p2p-tui', channel: 'tui' })

    return { type: 'ready' }
  }

  // Tear down resources after the Program exits.
  async shutdown() {
    if (this.bc) await this.bc.close()
    if (this.store) await this.store.close()
  }

  // ── rendering helpers ─────────────────────────────────────────────────────────

  // Visible rows inside the transcript border: total minus title(1),
  // border(2), status(1), input box(3).
  _bodyHeight() {
    return Math.max(3, this.height - 7)
  }

  // Content width inside the transcript border: total minus border(2) + padding(2).
  _innerWidth() {
    return Math.max(20, this.width - 4)
  }

  _refresh() {
    const w = this._innerWidth()
    const blocks = this.entries.map((e) => renderEntry(e, w))
    if (this.streaming && this.pending) {
      blocks.push(renderEntry({ role: 'assistant', text: this.pending }, w))
    }
    this.vp.setContent(blocks.join('\n\n'))
    this.vp.gotoBottom()
  }
}

// A coloured badge + an indented, wrapped body — so it's always clear who said
// what. Tool calls render compactly on a single line.
function renderEntry(entry, width) {
  const { role, text } = entry
  if (role === 'tool') {
    return badge('tool') + ' ' + style().foreground('yellow').render(text)
  }
  const body = wrap(text, width - 2)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
  const colored = role === 'system' ? style().faint(true).render(body) : body
  return badge(role) + '\n' + colored
}

// Reverse-video name badge per speaker.
function badge(role) {
  const tag = (fg, bg, txt) => style().bold().foreground(fg).background(bg).render(` ${txt} `)
  switch (role) {
    case 'user':
      return tag('black', 'green', 'YOU')
    case 'assistant':
      return tag('black', 'cyan', 'AGENT')
    case 'tool':
      return tag('black', 'yellow', 'TOOL')
    default:
      return tag('black', 'white', 'SYSTEM')
  }
}

// Word-wrap to width (viewport truncates rather than wraps, so we wrap first).
function wrap(text, width) {
  const w = Math.max(20, width)
  return String(text)
    .split('\n')
    .map((line) => {
      const out = []
      let cur = ''
      for (const word of line.split(' ')) {
        if (cur && (cur + ' ' + word).length > w) {
          out.push(cur)
          cur = word
        } else {
          cur = cur ? cur + ' ' + word : word
        }
      }
      out.push(cur)
      return out.join('\n')
    })
    .join('\n')
}

// One-line preview of a tool's input object for the log line.
function compact(input) {
  if (!input || typeof input !== 'object') return ''
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
    .slice(0, 60)
}

// Invoked last so the ChatApp class (not hoisted) is initialised first.
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
