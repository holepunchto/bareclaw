'use strict'

const tmp = require('test-tmp')
const Corestore = require('corestore')
const { Bareclaw } = require('../../index.js')

async function create(t, opts = {}) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  await store.ready()

  const bc = new Bareclaw(store, {
    provider: 'ollama',
    model: 'llama3.2',
    ...opts
  })
  await bc.ready()

  t.teardown(async () => {
    await bc.close()
  })

  return bc
}

module.exports = { create }
