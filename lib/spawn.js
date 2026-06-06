import { Duplex } from 'streamx'
import RPC from 'bare-rpc'
import Subprocess from 'bare-subprocess'

// Resolve the platform-specific binary path via the package.json import map.
// In Bare this is resolved at bundle time; in Node.js environments the caller
// should pass the binary path explicitly via opts.binary.
let defaultBinary
try {
  const { default: bin } = await import('#binary')
  defaultBinary = bin
} catch {
  defaultBinary = null
}

export function spawnRPC (opts = {}) {
  const binary = opts.binary || defaultBinary
  if (!binary) throw new Error('bareclaw: no binary path — pass opts.binary or bundle for Bare')

  const args = []
  if (opts.config) args.push('--config', opts.config)

  const proc = new Subprocess(binary, args, {
    stdio: ['pipe', 'pipe', 'inherit']
  })

  // Wrap stdin/stdout as a single Duplex stream for bare-rpc.
  const transport = new Duplex({
    write (data, cb) {
      proc.stdin.write(data, cb)
    },
    read (cb) {
      cb(null)
    }
  })

  proc.stdout.on('data', (chunk) => transport.push(chunk))
  proc.stdout.on('end', () => transport.push(null))
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      transport.destroy(new Error(`picoclaw-rpc exited with code ${code}`))
    }
  })

  const rpc = new RPC(transport)
  return { rpc, proc }
}
