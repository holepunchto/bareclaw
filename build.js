// Generates the wire schema and RPC for both sides from one definition.
// Run after changing anything here: node build.js
const HRPCBuilder = require('hrpc')
const Hyperschema = require('hyperschema')
const GoHyperschema = require('hyperschema-golang')
const GoHRPC = require('hrpc-golang')

const SCHEMA_DIR = './spec/schema'
const HRPC_DIR = './spec/hrpc'
const GO_SCHEMA_DIR = './go/schema'
const GO_HRPC_DIR = './go/hrpc'

// JavaScript output comes from the base builders; the Go generators load the spec they persist.
const schema = Hyperschema.from(SCHEMA_DIR)
const types = schema.namespace('bareclaw')

types.register({ name: 'empty', fields: [] })

types.register({
  name: 'chat-request',
  fields: [
    { name: 'sessionId', type: 'string', required: true },
    { name: 'message', type: 'string', required: true },
    { name: 'model', type: 'string' }
  ]
})

types.register({
  name: 'chunk-type',
  strings: true,
  enum: ['content', 'thinking', 'done', 'error']
})

types.register({
  name: 'chat-chunk',
  fields: [
    { name: 'type', type: '@bareclaw/chunk-type', required: true },
    { name: 'content', type: 'string' }
  ]
})

types.register({
  name: 'session-scope',
  fields: [
    { name: 'agentId', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'account', type: 'string' },
    { name: 'peer', type: 'string' }
  ]
})

types.register({ name: 'session-key', fields: [{ name: 'key', type: 'string', required: true }] })

types.register({
  name: 'session-list',
  fields: [{ name: 'keys', type: 'string', array: true, required: true }]
})

// data is the JSON history + summary picoclaw keeps for a session, stored verbatim in the bee
types.register({
  name: 'session-blob',
  fields: [
    { name: 'key', type: 'string', required: true },
    { name: 'data', type: 'buffer', required: true }
  ]
})

types.register({
  name: 'state-blob',
  fields: [{ name: 'sessions', type: '@bareclaw/session-blob', array: true, required: true }]
})

types.register({
  name: 'tool-def',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'string', required: true },
    { name: 'inputSchema', type: 'buffer' }
  ]
})

types.register({
  name: 'tool-call',
  fields: [
    { name: 'callId', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'input', type: 'buffer', required: true }
  ]
})

types.register({
  name: 'tool-result',
  fields: [
    { name: 'callId', type: 'string', required: true },
    { name: 'output', type: 'buffer' },
    { name: 'errMsg', type: 'string' }
  ]
})

types.register({ name: 'state-field', strings: true, enum: ['history', 'summary'] })

types.register({
  name: 'state-chunk',
  fields: [
    { name: 'sessionKey', type: 'string', required: true },
    { name: 'field', type: '@bareclaw/state-field', required: true },
    { name: 'data', type: 'buffer', required: true }
  ]
})

Hyperschema.toDisk(schema, { esm: false })
GoHyperschema.toDisk(GoHyperschema.from(SCHEMA_DIR), GO_SCHEMA_DIR)

const hrpc = HRPCBuilder.from(SCHEMA_DIR, HRPC_DIR)
const rpc = hrpc.namespace('bareclaw')

// JS -> Go
rpc.register({
  name: 'chat',
  request: { name: '@bareclaw/chat-request', stream: false },
  response: { name: '@bareclaw/chat-chunk', stream: true }
})
rpc.register({
  name: 'session-create',
  request: { name: '@bareclaw/session-scope', stream: false },
  response: { name: '@bareclaw/session-key', stream: false }
})
rpc.register({
  name: 'session-list',
  request: { name: '@bareclaw/empty', stream: false },
  response: { name: '@bareclaw/session-list', stream: false }
})
rpc.register({
  name: 'session-export',
  request: { name: '@bareclaw/session-key', stream: false },
  response: { name: '@bareclaw/session-blob', stream: false }
})
rpc.register({
  name: 'session-import',
  request: { name: '@bareclaw/session-blob', stream: false },
  response: { name: '@bareclaw/empty', stream: false }
})
rpc.register({
  name: 'state-export',
  request: { name: '@bareclaw/empty', stream: false },
  response: { name: '@bareclaw/state-blob', stream: false }
})
rpc.register({
  name: 'state-import',
  request: { name: '@bareclaw/state-blob', stream: false },
  response: { name: '@bareclaw/empty', stream: false }
})
rpc.register({
  name: 'tool-register',
  request: { name: '@bareclaw/tool-def', stream: false },
  response: { name: '@bareclaw/empty', stream: false }
})

// Go -> JS
rpc.register({
  name: 'tool-exec',
  request: { name: '@bareclaw/tool-call', stream: false },
  response: { name: '@bareclaw/tool-result', stream: false }
})
rpc.register({
  name: 'state-changed',
  request: { name: '@bareclaw/state-chunk', send: true }
})

HRPCBuilder.toDisk(hrpc, { esm: false })
GoHRPC.toDisk(GoHRPC.from(SCHEMA_DIR, HRPC_DIR), GO_HRPC_DIR, {
  schemaImport: 'github.com/holepunchto/bareclaw/schema'
})
