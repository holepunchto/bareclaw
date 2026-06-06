import c from 'compact-encoding'

// Command IDs — must stay in sync with go/pkg/rpc/codecs.go
export const CMD_CHAT           = 1
export const CMD_SESSION_CREATE = 2
export const CMD_SESSION_LIST   = 3
export const CMD_SESSION_EXPORT = 4
export const CMD_SESSION_IMPORT = 5
export const CMD_STATE_EXPORT   = 6
export const CMD_STATE_IMPORT   = 7
export const CMD_TOOL_REGISTER  = 8

export const CMD_TOOL_EXEC      = 100
export const CMD_STATE_CHANGED  = 101

// ChatChunk.type values
export const CHUNK_CONTENT  = 0
export const CHUNK_THINKING = 1
export const CHUNK_DONE     = 2
export const CHUNK_ERROR    = 3

// StateChunk.field values
export const STATE_FIELD_HISTORY = 0
export const STATE_FIELD_SUMMARY = 1

// ---------------------------------------------------------------------------
// Codec helpers — each codec is { encode(value) -> Buffer, decode(Buffer) -> value }
// Fields are encoded in the same order as the Go structs (declaration order).
// ---------------------------------------------------------------------------

function encodeStruct (fields) {
  const state = { start: 0, end: 0, buffer: null }
  for (const [codec, val] of fields) codec.preencode(state, val)
  state.buffer = Buffer.allocUnsafe(state.end)
  for (const [codec, val] of fields) codec.encode(state, val)
  return state.buffer
}

function decodeField (state, codec) {
  return codec.decode(state)
}

function stateOf (buf) {
  return { start: 0, end: buf.byteLength, buffer: buf }
}

// ChatRequest { SessionID string, Message string, Model string }
export const chatRequest = {
  encode ({ sessionId, message, model = '' }) {
    return encodeStruct([
      [c.string, sessionId],
      [c.string, message],
      [c.string, model]
    ])
  },
  decode (buf) {
    const s = stateOf(buf)
    return {
      sessionId: decodeField(s, c.string),
      message:   decodeField(s, c.string),
      model:     decodeField(s, c.string)
    }
  }
}

// ChatChunk { Type uint8, Content string }
export const chatChunk = {
  encode ({ type, content }) {
    return encodeStruct([[c.uint8, type], [c.string, content]])
  },
  decode (buf) {
    const s = stateOf(buf)
    return { type: decodeField(s, c.uint8), content: decodeField(s, c.string) }
  }
}

// SessionScope { AgentID, Channel, Account, Peer string }
export const sessionScope = {
  encode ({ agentId = '', channel = '', account = '', peer = '' }) {
    return encodeStruct([
      [c.string, agentId],
      [c.string, channel],
      [c.string, account],
      [c.string, peer]
    ])
  },
  decode (buf) {
    const s = stateOf(buf)
    return {
      agentId:  decodeField(s, c.string),
      channel:  decodeField(s, c.string),
      account:  decodeField(s, c.string),
      peer:     decodeField(s, c.string)
    }
  }
}

// SessionKey { Key string }
export const sessionKey = {
  encode ({ key }) { return encodeStruct([[c.string, key]]) },
  decode (buf) {
    const s = stateOf(buf)
    return { key: decodeField(s, c.string) }
  }
}

// SessionList { Keys []string } — varuint(len) + string...
export const sessionList = {
  decode (buf) {
    const s = stateOf(buf)
    const n = c.uint.decode(s)
    const keys = []
    for (let i = 0; i < n; i++) keys.push(c.string.decode(s))
    return keys
  }
}

// SessionBlob { Key string, Data []byte }
export const sessionBlob = {
  encode ({ key, data }) {
    return encodeStruct([[c.string, key], [c.buffer, data]])
  },
  decode (buf) {
    const s = stateOf(buf)
    return { key: decodeField(s, c.string), data: decodeField(s, c.buffer) }
  }
}

// ToolDef { Name, Description string, InputSchema []byte }
export const toolDef = {
  encode ({ name, description, inputSchema }) {
    const schemaBytes = inputSchema
      ? Buffer.from(JSON.stringify(inputSchema))
      : Buffer.alloc(0)
    return encodeStruct([
      [c.string, name],
      [c.string, description],
      [c.buffer, schemaBytes]
    ])
  }
}

// ToolCall { CallID, Name string, Input []byte } — decoded Go→JS
export const toolCall = {
  decode (buf) {
    const s = stateOf(buf)
    return {
      callId: decodeField(s, c.string),
      name:   decodeField(s, c.string),
      input:  JSON.parse(decodeField(s, c.buffer).toString())
    }
  }
}

// ToolResult { CallID, Output []byte, ErrMsg string } — encoded JS→Go
export const toolResult = {
  encode ({ callId, output, errMsg = '' }) {
    const outputBytes = output
      ? Buffer.from(JSON.stringify(output))
      : Buffer.alloc(0)
    return encodeStruct([
      [c.string, callId],
      [c.buffer, outputBytes],
      [c.string, errMsg]
    ])
  }
}

// StateChunk { SessionKey string, Field uint8, Data []byte }
export const stateChunk = {
  decode (buf) {
    const s = stateOf(buf)
    return {
      sessionKey: decodeField(s, c.string),
      field:      decodeField(s, c.uint8),
      data:       decodeField(s, c.buffer)
    }
  }
}
