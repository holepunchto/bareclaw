const test = require('brittle')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const { Bareclaw } = require('.')

async function main() {
  const store = new Corestore('./store')
  await store.ready()

  const bc = new Bareclaw(store, {
    provider: 'ollama',
    model: 'llama3.2'
  })
  await bc.ready()

  const key = await bc.session({ agentId: 'test', channel: 'chat-test' })

  for await (const chunk of bc.chat(key, 'Reply with exactly one word.')) {
    console.log(chunk)
  }

  await bc.close()
}

main().catch(console.error)
