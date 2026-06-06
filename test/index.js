const test = require('brittle')
const tmp = require('test-tmp')
const Corestore = require('corestore')

const { Bareclaw } = require('../index.js')
const { create } = require('./helpers')

test('session() returns a deterministic string key', async (t) => {
  const bc = await create(t)

  const scope = { agentId: 'test', channel: 'general', account: 'alice', peer: '' }
  const k1 = await bc.session(scope)
  const k2 = await bc.session(scope)

  t.is(typeof k1, 'string')
  t.ok(k1.length > 0)
  t.is(k1, k2, 'same scope → same key')
})

test('sessions() lists created sessions', async (t) => {
  const bc = await create(t)

  const key = await bc.session({ agentId: 'test', channel: 'list-test' })
  const list = await bc.sessions()

  t.ok(Array.isArray(list))
  t.ok(list.includes(key))
})

test('exportSession / importSession round-trip', async (t) => {
  const bc = await create(t)

  const key = await bc.session({ agentId: 'test', channel: 'export-test' })
  const blob = await bc.exportSession(key)

  t.ok(Buffer.isBuffer(blob) || blob instanceof Uint8Array)
  t.ok(blob.length > 0)

  const bc2 = await create(t)
  await bc2.importSession(key, blob)

  const list = await bc2.sessions()
  t.ok(list.includes(key), 'imported session visible in list')
})

test('state persists across close and reopen', async (t) => {
  const dir = await tmp(t)

  const store = new Corestore(dir)
  await store.ready()
  const bc = new Bareclaw(store)
  await bc.ready()
  const key = await bc.session({ agentId: 'test', channel: 'persist-test' })
  await bc.close()
  await store.close()

  const store2 = new Corestore(dir)
  await store2.ready()
  const bc2 = new Bareclaw(store2)
  await bc2.ready()
  t.teardown(async () => {
    await bc2.close()
    await store2.close()
  })

  const list = await bc2.sessions()
  t.ok(list.includes(key), 'session survives close/reopen via store')
})

test('chat streams content and ends with a done chunk', async (t) => {
  const bc = await create(t)
  const key = await bc.session({ agentId: 'test', channel: 'chat-test' })

  const chunks = []
  for await (const chunk of bc.chat(key, 'Reply with exactly one word.')) {
    chunks.push(chunk)
  }

  const last = chunks.at(-1)
  t.ok(last.done, 'stream terminates')
  t.is(last.type, 'done', 'final chunk is done')

  const text = chunks
    .filter((c) => c.type === 'content')
    .map((c) => c.content)
    .join('')
  t.ok(text.length > 0, 'got content')
})

test('registerTool receives call and replies', async (t) => {
  t.plan(2)
  const bc = await create(t)

  let received = null
  await bc.registerTool(
    'reverse',
    'Reverses a string',
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async (input) => {
      received = input
      return { result: input.text.split('').reverse().join('') }
    }
  )

  const key = await bc.session({ agentId: 'test', channel: 'tool-test' })

  const chunks = []
  for await (const chunk of bc.chat(key, 'Use the reverse tool with text "hello"')) {
    chunks.push(chunk)
  }

  t.ok(received !== null, 'tool handler was called')
  t.is(chunks.at(-1).type, 'done')
})
