'use strict'

const EventEmitter = require('bare-events')
const RPC = require('bare-rpc')
const { spawn } = require('bare-subprocess')
const bareclaw = require('./bareclaw')

class Transport extends EventEmitter {
  constructor(proc) {
    super()
    this._stdin = proc.stdin
    proc.stdout.on('data', (chunk) => this.emit('data', chunk))
    proc.stdout.on('end', () => this.emit('end'))
    proc.stdout.on('error', (err) => this.emit('error', err))
    proc.stdin.on('drain', () => this.emit('drain'))
    proc.stdout.resume()
  }

  write(data, cb) {
    return this._stdin.write(data, cb)
  }

  destroy(err) {
    if (err) this.emit('error', err)
  }
}

function spawnRPC(opts = {}, onrequest) {
  const args = []
  // `config` may be an inline object (preferred, passed as JSON) or a file path.
  if (opts.config && typeof opts.config === 'object') {
    args.push('--config-json', JSON.stringify(opts.config))
  } else if (opts.config) {
    args.push('--config', opts.config)
  }
  if (opts.provider) args.push('--provider', opts.provider)
  if (opts.apiKey) args.push('--api-key', opts.apiKey)
  if (opts.model) args.push('--model', opts.model)
  if (opts.apiBase) args.push('--api-base', opts.apiBase)
  // Lean by default: tools come from registerTool. Opt back into picoclaw's
  // built-in OS tools with `builtinTools: true`.
  if (opts.builtinTools) args.push('--builtin-tools')

  const proc = spawn(bareclaw, args, { stdio: ['pipe', 'pipe', 'inherit'] })

  const transport = new Transport(proc)

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      transport.destroy(new Error(`bareclaw rpc process exited with code ${code}`))
    }
  })

  const rpc = new RPC(transport, onrequest)
  return { rpc, proc }
}

module.exports = { spawnRPC }
