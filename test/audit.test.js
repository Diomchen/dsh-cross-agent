import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAudit } from '../src/audit.js'
import { createStore } from '../src/store.js'

async function setup () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-audit-'))
  const store = await createStore({ dir })
  const audit = createAudit({ store })
  return {
    audit,
    store,
    async cleanup () { await fs.rm(dir, { recursive: true, force: true }) }
  }
}

test('指令方向只收 in / out，别的值当作没填', async () => {
  const { audit, cleanup } = await setup()
  try {
    await audit.record({ kind: 'instruction', outcome: 'answered', detail: '让它装一下', direction: 'in' })
    await audit.record({ kind: 'instruction', outcome: 'answered', detail: '让它跑测试', direction: 'out' })
    await audit.record({ kind: 'instruction', outcome: 'answered', detail: '老调用没给方向' })
    await audit.record({ kind: 'instruction', outcome: 'answered', detail: '脏值', direction: 'sideways' })

    const rows = await audit.recent(10)
    assert.deepEqual(rows.map((row) => row.direction), [null, null, 'out', 'in'])
  } finally {
    await cleanup()
  }
})

test('方向会跟着记录落盘，读回来还在', async () => {
  const { audit, store, cleanup } = await setup()
  try {
    await audit.record({ kind: 'instruction', outcome: 'no-reply', detail: '你好', direction: 'in' })
    const persisted = await store.list('audit')
    assert.equal(persisted.at(-1).direction, 'in')
  } finally {
    await cleanup()
  }
})
