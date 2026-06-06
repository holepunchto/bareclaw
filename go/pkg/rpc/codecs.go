package rpc

// Command IDs — must stay in sync with lib/codecs.js.
const (
	// JS → Go
	CmdChat          uint = 1
	CmdSessionCreate uint = 2
	CmdSessionList   uint = 3
	CmdSessionExport uint = 4
	CmdSessionImport uint = 5
	CmdStateExport   uint = 6
	CmdStateImport   uint = 7
	CmdToolRegister  uint = 8

	// Go → JS callbacks
	CmdToolExec     uint = 100
	CmdStateChanged uint = 101
)

// ChatChunk.Type values.
const (
	ChunkContent uint8 = 0
	ChunkThinking uint8 = 1
	ChunkDone    uint8 = 2
	ChunkError   uint8 = 3
)

// StateChunk.Field values.
const (
	StateFieldHistory uint8 = 0
	StateFieldSummary uint8 = 1
)

// ChatRequest is the payload for CmdChat.
type ChatRequest struct {
	SessionID string
	Message   string
	Model     string // empty → use agent default
}

// ChatChunk is a single frame in the CmdChat response stream.
type ChatChunk struct {
	Type    uint8
	Content string
}

// SessionScope identifies or creates a session.
type SessionScope struct {
	AgentID string
	Channel string
	Account string
	Peer    string
}

// SessionKey is returned by CmdSessionCreate and CmdSessionList elements.
type SessionKey struct {
	Key string
}

// SessionBlob carries serialised session state for export/import.
type SessionBlob struct {
	Key  string
	Data []byte // JSON-encoded history + summary
}

// StateBlob is returned by CmdStateExport and consumed by CmdStateImport.
// It is an array of SessionBlobs encoded as: varuint(count) + SessionBlob...
// The RPC layer wraps the whole thing in a compact buffer.
type StateBlob struct {
	Data []byte
}

// ToolDef describes a JS-side tool being registered via CmdToolRegister.
type ToolDef struct {
	Name        string
	Description string
	InputSchema []byte // JSON Schema bytes
}

// ToolCall is sent Go → JS via CmdToolExec.
type ToolCall struct {
	CallID string
	Name   string
	Input  []byte // JSON-encoded tool input
}

// ToolResult is the JS reply to a CmdToolExec request.
type ToolResult struct {
	CallID string
	Output []byte // JSON-encoded tool output
	ErrMsg string // non-empty on error
}

// StateChunk is sent Go → JS via CmdStateChanged after each turn.
type StateChunk struct {
	SessionKey string
	Field      uint8
	Data       []byte
}
