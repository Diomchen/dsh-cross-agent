import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApprovals } from '../src/approvals.js'
import { createAudit } from '../src/audit.js'
import { createStore } from '../src/store.js'

async function setup (options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-approvals-'))
  const store = await createStore({ dir })
  const audit = createAudit({ store })
  let at = 1_000
  const approvals = createApprovals({ store, audit, now: () => at, ...options })
  await approvals.open()
  return {
    approvals,
    store,
    advance (ms) { at += ms },
    async cleanup () { await fs.rm(dir, { recursive: true, force: true }) }
  }
}

test('同一条待办不会重复入队', async () => {
  const { approvals, cleanup } = await setup()
  try {
    const first = await approvals.enqueue({ kind: 'ask', peerId: 'p1', summary: '做点事' })
    const second = await approvals.enqueue({ kind: 'ask', peerId: 'p1', summary: '做点事' })
    assert.equal(first.id, second.id)
    assert.equal(approvals.list({ status: 'pending' }).length, 1)
  } finally {
    await cleanup()
  }
})

test('同意 + 记住 24h 只作用于这条连接这类动作', async () => {
  const { approvals, cleanup } = await setup()
  try {
    const item = await approvals.enqueue({ kind: 'ask', peerId: 'p1', summary: 'x' })
    await approvals.resolve(item.id, 'approved', { remember: true })
    assert.equal(await approvals.hasGrant('p1', 'ask'), true)
    assert.equal(await approvals.hasGrant('p1', 'file'), false)
    assert.equal(await approvals.hasGrant('p2', 'ask'), false)
  } finally {
    await cleanup()
  }
})

test('过期后就不同意了', async () => {
  const { approvals, advance, cleanup } = await setup({ ttlMs: 1000 })
  try {
    const item = await approvals.enqueue({ kind: 'file', peerId: 'p1', summary: 'a.txt' })
    advance(2000)
    await assert.rejects(() => approvals.resolve(item.id, 'approved'), /过期/)
    assert.equal(approvals.list({ status: 'pending' }).length, 0)
  } finally {
    await cleanup()
  }
})

test('超时之后人才点同意，回调仍然会跑', async () => {
  const { approvals, cleanup } = await setup()
  try {
    const item = await approvals.enqueue({ kind: 'ask', peerId: 'p1', summary: 'x' })
    let seen = null
    approvals.onResolve(item.id, (decided) => {
      seen = decided.status
    })
    const timedOut = await approvals.waitFor(item.id, 10)
    assert.equal(timedOut, null)
    await approvals.resolve(item.id, 'approved')
    assert.equal(seen, 'approved')
  } finally {
    await cleanup()
  }
})

test('拒绝会落审计', async () => {
  const { approvals, store, cleanup } = await setup()
  try {
    const item = await approvals.enqueue({ kind: 'ask', peerId: 'p1', summary: 'x' })
    await approvals.resolve(item.id, 'rejected')
    const rows = await store.list('audit')
    assert.ok(rows.some((row) => row.kind === 'review' && row.outcome === 'rejected'))
  } finally {
    await cleanup()
  }
})
