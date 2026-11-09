import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createAudit } from '../src/audit.js'
import { createFiles } from '../src/files.js'
import { createStore } from '../src/store.js'

async function setup () {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-files-'))
  const store = await createStore({ dir: path.join(root, 'data') })
  const audit = createAudit({ store })
  const files = createFiles({
    store,
    rpc: null,
    audit,
    inboxRoot: path.join(root, 'inbox'),
    shareRoot: path.join(root, 'share')
  })
  await files.init()
  return { root, store, files, async cleanup () { await fs.rm(root, { recursive: true, force: true }) } }
}

function upload (buffer) {
  return {
    peerId: 'peer-1',
    peerName: 'B 机',
    name: 'report.txt',
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    transferId: crypto.randomUUID(),
    stream: Readable.from([buffer])
  }
}

test('收到文件：落盘、校验、回执', async () => {
  const { root, files, cleanup } = await setup()
  try {
    const buffer = crypto.randomBytes(64 * 1024)
    const receipt = await files.receive(upload(buffer))
    assert.equal(receipt.ok, true)
    assert.equal(receipt.size, buffer.length)
    const written = await fs.readFile(receipt.path)
    assert.equal(written.toString('hex'), buffer.toString('hex'))
    assert.ok(receipt.path.startsWith(path.join(root, 'inbox', 'B 机')))
  } finally {
    await cleanup()
  }
})

test('同名不覆盖，加序号', async () => {
  const { files, cleanup } = await setup()
  try {
    const buffer = Buffer.from('one')
    const first = await files.receive(upload(buffer))
    const second = await files.receive(upload(Buffer.from('two')))
    assert.notEqual(first.path, second.path)
    assert.equal(path.basename(second.path), 'report(1).txt')
  } finally {
    await cleanup()
  }
})

test('哈希不对：不落盘、不留半截', async () => {
  const { files, root, cleanup } = await setup()
  try {
    const job = upload(Buffer.from('payload'))
    job.sha256 = 'f'.repeat(64)
    await assert.rejects(() => files.receive(job), /sha/)
    const inbox = path.join(root, 'inbox')
    const entries = await fs.readdir(inbox).catch(() => [])
    assert.deepEqual(entries.filter((name) => name !== '.tmp'), [])
    const temp = await fs.readdir(path.join(inbox, '.tmp'))
    assert.deepEqual(temp, [])
  } finally {
    await cleanup()
  }
})

test('超过单件上限在读之前就拒', async () => {
  const { files, cleanup } = await setup()
  try {
    const job = upload(Buffer.from('x'))
    job.size = 200 * 1024 * 1024
    await assert.rejects(() => files.receive(job), /too-large/)
  } finally {
    await cleanup()
  }
})

test('断流：报错并清掉临时文件', async () => {
  const { files, root, cleanup } = await setup()
  try {
    const broken = Readable.from((async function * () {
      yield Buffer.from('part')
      throw new Error('connection reset')
    })())
    const job = upload(Buffer.from('part'))
    job.stream = broken
    await assert.rejects(() => files.receive(job), /connection reset/)
    const temp = await fs.readdir(path.join(root, 'inbox', '.tmp'))
    assert.deepEqual(temp, [])
  } finally {
    await cleanup()
  }
})

test('共享目录只读，且拒绝越界路径', async () => {
  const { files, root, cleanup } = await setup()
  try {
    const share = path.join(root, 'share')
    await fs.mkdir(path.join(share, 'reports'), { recursive: true })
    await fs.writeFile(path.join(share, 'reports', 'a.md'), 'hello')

    const opened = await files.openShared({ shareRoot: share, relPath: 'reports/a.md' })
    assert.equal(opened.name, 'a.md')
    assert.equal(opened.size, 5)

    await assert.rejects(() => files.openShared({ shareRoot: share, relPath: '../data/identity.json' }), /bad-path/)
    await assert.rejects(() => files.openShared({ shareRoot: share, relPath: '/etc/passwd' }), /bad-path/)
  } finally {
    await cleanup()
  }
})
