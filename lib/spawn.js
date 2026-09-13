'use strict'

const { spawn } = require('bare-subprocess')
const HRPC = require('../spec/hrpc')
const bareclaw = require('./bareclaw')

// Spawns the Go agent with an RPC pipe on fd 3, leaving stdout and stderr for logs.
function spawnRPC(opts = {}) {
  const args = []
  if (opts.config && typeof opts.config === 'object') {
    args.push('--config-json', JSON.stringify(opts.config))
  } else if (opts.config) {
    args.push('--config', opts.config)
  }
  if (opts.provider) args.push('--provider', opts.provider)
  if (opts.apiKey) args.push('--api-key', opts.apiKey)
  if (opts.model) args.push('--model', opts.model)
  if (opts.apiBase) args.push('--api-base', opts.apiBase)
  if (opts.builtinTools) args.push('--builtin-tools')

  const proc = spawn(bareclaw, args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] })
  const pipe = proc.stdio[3]
  const rpc = new HRPC(pipe)

  return { rpc, proc, pipe }
}

module.exports = { spawnRPC }
