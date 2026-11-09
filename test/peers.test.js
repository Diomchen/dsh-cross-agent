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
