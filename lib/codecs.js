'use strict'

const c = require('compact-encoding')

// Command IDs — must stay in sync with go/pkg/rpc/codecs.go
const CMD_CHAT = 1
const CMD_SESSION_CREATE = 2
const CMD_SESSION_LIST = 3
const CMD_SESSION_EXPORT = 4
const CMD_SESSION_IMPORT = 5
const CMD_STATE_EXPORT = 6
const CMD_STATE_IMPORT = 7
const CMD_TOOL_REGISTER = 8

const CMD_TOOL_EXEC = 100
const CMD_STATE_CHANGED = 101

// ChatChunk.type values (wire format) and their public string names. The chat()
// API yields the string names so callers never deal with raw enum integers.
const CHUNK_CONTENT = 0
const CHUNK_THINKING = 1
const CHUNK_DONE = 2
const CHUNK_ERROR = 3

const CHUNK_TYPE_NAMES = ['content', 'thinking', 'done', 'error']

// StateChunk.field values
const STATE_FIELD_HISTORY = 0
const STATE_FIELD_SUMMARY = 1

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

function encodeStruct(fields) {
  const state = { start: 0, end: 0, buffer: null }
  for (const [codec, val] of fields) codec.preencode(state, val)
  state.buffer = Buffer.allocUnsafe(state.end)
  for (const [codec, val] of fields) codec.encode(state, val)
  return state.buffer
}

function decodeField(state, codec) {
  return codec.decode(state)
}

function stateOf(buf) {
  return { start: 0, end: buf.byteLength, buffer: buf }
}

const chatRequest = {
  encode({ sessionId, message, model = '' }) {
    return encodeStruct([
      [c.string, sessionId],
      [c.string, message],
      [c.string, model]
    ])
  },
  decode(buf) {
    const s = stateOf(buf)
    return {
      sessionId: decodeField(s, c.string),
      message: decodeField(s, c.string),
      model: decodeField(s, c.string)
    }
  }
}

const chatChunk = {
  encode({ type, content }) {
    return encodeStruct([
      [c.uint8, type],
      [c.string, content]
    ])
  },
  decode(buf) {
    const s = stateOf(buf)
    return { type: decodeField(s, c.uint8), content: decodeField(s, c.string) }
  }
}

const sessionScope = {
  encode({ agentId = '', channel = '', account = '', peer = '' }) {
    return encodeStruct([
      [c.string, agentId],
      [c.string, channel],
      [c.string, account],
      [c.string, peer]
    ])
  },
  decode(buf) {
    const s = stateOf(buf)
    return {
      agentId: decodeField(s, c.string),
      channel: decodeField(s, c.string),
      account: decodeField(s, c.string),
      peer: decodeField(s, c.string)
    }
  }
}

const sessionKey = {
  encode({ key }) {
    return encodeStruct([[c.string, key]])
  },
  decode(buf) {
    const s = stateOf(buf)
    return { key: decodeField(s, c.string) }
  }
}

const sessionList = {
  decode(buf) {
    const s = stateOf(buf)
    const n = c.uint.decode(s)
    const keys = []
    for (let i = 0; i < n; i++) keys.push(c.string.decode(s))
    return keys
  }
}

const sessionBlob = {
  encode({ key, data }) {
    return encodeStruct([
      [c.string, key],
      [c.buffer, data]
    ])
  },
  decode(buf) {
    const s = stateOf(buf)
    return { key: decodeField(s, c.string), data: decodeField(s, c.buffer) }
  }
}

const toolDef = {
  encode({ name, description, inputSchema }) {
    const schemaBytes = inputSchema ? Buffer.from(JSON.stringify(inputSchema)) : Buffer.alloc(0)
    return encodeStruct([
      [c.string, name],
      [c.string, description],
      [c.buffer, schemaBytes]
    ])
  }
}

const toolCall = {
  decode(buf) {
    const s = stateOf(buf)
    return {
      callId: decodeField(s, c.string),
      name: decodeField(s, c.string),
      input: JSON.parse(decodeField(s, c.buffer).toString())
    }
  }
}

const toolResult = {
  encode({ callId, output, errMsg = '' }) {
    const outputBytes = output ? Buffer.from(JSON.stringify(output)) : Buffer.alloc(0)
    return encodeStruct([
      [c.string, callId],
      [c.buffer, outputBytes],
      [c.string, errMsg]
    ])
  }
}

const stateChunk = {
  decode(buf) {
    const s = stateOf(buf)
    return {
      sessionKey: decodeField(s, c.string),
      field: decodeField(s, c.uint8),
      data: decodeField(s, c.buffer)
    }
  }
}

module.exports = {
  CMD_CHAT,
  CMD_SESSION_CREATE,
  CMD_SESSION_LIST,
  CMD_SESSION_EXPORT,
  CMD_SESSION_IMPORT,
  CMD_STATE_EXPORT,
  CMD_STATE_IMPORT,
  CMD_TOOL_REGISTER,
  CMD_TOOL_EXEC,
  CMD_STATE_CHANGED,
  CHUNK_CONTENT,
  CHUNK_THINKING,
  CHUNK_DONE,
  CHUNK_ERROR,
  CHUNK_TYPE_NAMES,
  STATE_FIELD_HISTORY,
  STATE_FIELD_SUMMARY,
  chatRequest,
  chatChunk,
  sessionScope,
  sessionKey,
  sessionList,
  sessionBlob,
  toolDef,
  toolCall,
  toolResult,
  stateChunk
}
