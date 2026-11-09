import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStore } from '../src/store.js'

async function tempStore () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-store-'))
  const store = await createStore({ dir })
  return { dir, store, async cleanup () { await fs.rm(dir, { recursive: true, force: true }) } }
}

test('键值表可读可写可删', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await store.put('peers', 'a', { name: 'A' })
    assert.deepEqual(await store.get('peers', 'a'), { name: 'A' })
    assert.equal(await store.size('peers'), 1)
    const rows = await store.entries('peers')
    assert.equal(rows[0].key, 'a')
    assert.equal(await store.delete('peers', 'a'), true)
    assert.equal(await store.get('peers', 'a'), undefined)
  } finally {
    await cleanup()
  }
})

test('环形表只保留最后 N 条', async () => {
  const { store, cleanup } = await tempStore()
  try {
    for (let i = 1; i <= 12; i += 1) await store.appendBounded('audit', { seq: i }, 10)
    const rows = await store.list('audit')
    assert.equal(rows.length, 10)
    assert.equal(rows[0].seq, 3)
    assert.equal(rows[9].seq, 12)
  } finally {
    await cleanup()
  }
})

test('重启后数据还在', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    await store.put('identity', 'self', { deviceId: 'x' })
    await store.close()
    const again = await createStore({ dir })
    assert.deepEqual(await again.get('identity', 'self'), { deviceId: 'x' })
    await again.close()
  } finally {
    await cleanup()
  }
})

test('写坏的 JSON 不会让插件崩，按空表处理', async () => {
  const { dir, store, cleanup } = await tempStore()
  try {
    await fs.writeFile(path.join(dir, 'peers.json'), '{ broken')
    assert.equal(await store.size('peers'), 0)
  } finally {
    await cleanup()
  }
})
