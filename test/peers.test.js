import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApprovals } from '../src/approvals.js'
import { createAudit } from '../src/audit.js'
import { createPeers } from '../src/peers.js'
import { createKeyPair, exportPrivateKey, exportPublicKey } from '../src/protocol.js'
import { createStore } from '../src/store.js'

function identityFor (name) {
  const pair = createKeyPair()
  return {
    deviceId: crypto.randomUUID(),
    name,
    publicKey: exportPublicKey(pair.publicKey),
    privateKey: exportPrivateKey(pair.privateKey)
  }
}

async function makeNode (name, registry) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-ca-${name}-`))
  const store = await createStore({ dir })
  const audit = createAudit({ store })
  const approvals = createApprovals({ store, audit })
  await approvals.open()
  const identity = identityFor(name)

  const send = async (deviceId, method, requestPath, body) => {
    const target = [...registry.values()].find((node) => node.identity.deviceId === deviceId)
    if (target === undefined) throw new Error('offline')
    if (requestPath === '/ca/v1/hello') return target.peers.handleHello(body, { source: 'test' })
    if (requestPath === '/ca/v1/hello-confirm') return target.peers.handleHelloConfirm(body, {})
    throw new Error(`unexpected path ${requestPath}`)
  }

  const node = { name, identity, store, audit, approvals, dir }
  node.peers = createPeers({ store, identity, audit, approvals, send })
  await node.peers.open()
  registry.set(name, node)
  return node
}

test('hello → 人放行 → hello-confirm：两端同一把钥匙', async () => {
  const registry = new Map()
  const a = await makeNode('A', registry)
  const b = await makeNode('B', registry)
  try {
    await a.peers.beginAdmission(b.identity.deviceId)
    assert.equal(a.peers.get(b.identity.deviceId).state, 'pending')
    assert.equal(b.peers.get(a.identity.deviceId).state, 'pending')

    const pending = b.approvals.list({ status: 'pending' })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'hello')

    await b.peers.approve(a.identity.deviceId)
    assert.equal(b.peers.get(a.identity.deviceId).state, 'admitted')
    assert.equal(b.peers.get(a.identity.deviceId).mode, 'confirm')
    assert.equal(a.peers.get(b.identity.deviceId).state, 'admitted')

    const keyA = a.peers.keyFor(b.identity.deviceId)
    const keyB = b.peers.keyFor(a.identity.deviceId)
    assert.equal(keyA.toString('hex'), keyB.toString('hex'))
    assert.equal(a.peers.get(b.identity.deviceId).fingerprint, b.peers.get(a.identity.deviceId).fingerprint)
  } finally {
    for (const node of registry.values()) await fs.rm(node.dir, { recursive: true, force: true })
  }
})

test('未放行时没有密钥；封禁后 hello 被拒', async () => {
  const registry = new Map()
  const a = await makeNode('A', registry)
  const b = await makeNode('B', registry)
  try {
    assert.equal(a.peers.keyFor(b.identity.deviceId), null)
    await b.peers.block(a.identity.deviceId)
    await assert.rejects(() => a.peers.beginAdmission(b.identity.deviceId), /handshake|blocked|握手|接受/)
  } finally {
    for (const node of registry.values()) await fs.rm(node.dir, { recursive: true, force: true })
  }
})

test('改成 open 需要二次确认', async () => {
  const registry = new Map()
  const a = await makeNode('A', registry)
  const b = await makeNode('B', registry)
  try {
    await a.peers.beginAdmission(b.identity.deviceId)
    await b.peers.approve(a.identity.deviceId)
    await assert.rejects(() => b.peers.setMode(a.identity.deviceId, 'open'), /二次确认/)
    const view = await b.peers.setMode(a.identity.deviceId, 'open', { confirmed: true })
    assert.equal(view.mode, 'open')
    const auditRows = await b.store.list('audit')
    assert.ok(auditRows.some((row) => row.kind === 'mode' && row.outcome === 'open'))
  } finally {
    for (const node of registry.values()) await fs.rm(node.dir, { recursive: true, force: true })
  }
})

test('别名只存本机：设置、解析、落盘、清除', async () => {
  const registry = new Map()
  const a = await makeNode('A', registry)
  const b = await makeNode('B', registry)
  try {
    const view = await a.peers.setAlias(b.identity.deviceId, 'Windows 测试机', 'B')
    assert.equal(view.alias, 'Windows 测试机')
    assert.equal(a.peers.get(b.identity.deviceId).alias, 'Windows 测试机')

    const row = a.peers.list().find((peer) => peer.deviceId === b.identity.deviceId)
    assert.equal(row.alias, 'Windows 测试机')
    assert.equal(row.name, 'B')

    // 大小写不敏感；deviceId 仍然精确优先
    assert.equal(a.peers.resolve('windows 测试机').deviceId, b.identity.deviceId)
    assert.equal(a.peers.resolve(b.identity.deviceId).deviceId, b.identity.deviceId)

    const stored = await a.store.get('peers', b.identity.deviceId)
    assert.equal(stored.alias, 'Windows 测试机')

    const reopened = createPeers({ store: a.store, identity: a.identity, audit: a.audit, approvals: a.approvals, send: async () => {} })
    await reopened.open()
    assert.equal(reopened.get(b.identity.deviceId).alias, 'Windows 测试机')

    await a.peers.setAlias(b.identity.deviceId, '')
    assert.equal(a.peers.get(b.identity.deviceId).alias, '')
    assert.equal(a.peers.resolve('Windows 测试机'), null)
  } finally {
    for (const node of registry.values()) await fs.rm(node.dir, { recursive: true, force: true })
  }
})

test('别名之间不能撞车；和显示名撞车时别名优先', async () => {
  const registry = new Map()
  const a = await makeNode('A', registry)
  const b = await makeNode('B', registry)
  const c = await makeNode('C', registry)
  try {
    await a.peers.setAlias(b.identity.deviceId, 'Windows', 'B')
    await assert.rejects(() => a.peers.setAlias(c.identity.deviceId, 'windows', 'C'), /已经用在另一个对端/)

    await a.peers.setAlias(c.identity.deviceId, 'B', 'C')
    assert.equal(a.peers.resolve('B').deviceId, c.identity.deviceId, '本机别名应该压过另一个对端的显示名')

    await assert.rejects(() => a.peers.setAlias(a.identity.deviceId, '自己'), /本机/)
    await assert.rejects(() => a.peers.setAlias('not-a-uuid', 'x'), /不合法/)
    await assert.rejects(() => a.peers.setAlias(crypto.randomUUID(), '幽灵'), /没有这个对端/)
  } finally {
    for (const node of registry.values()) await fs.rm(node.dir, { recursive: true, force: true })
  }
})
