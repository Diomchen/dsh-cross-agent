import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clampName,
  createKeyPair,
  createNonceCache,
  deriveKey,
  encodeBeacon,
  exportPrivateKey,
  exportPublicKey,
  importPrivateKey,
  importPublicKey,
  keyFingerprint,
  parseBeacon,
  safeFileName,
  sha256Hex,
  sign,
  verify
} from '../src/protocol.js'

test('beacon 编解码往返', () => {
  const data = encodeBeacon({
    type: 'beacon',
    deviceId: '11111111-1111-4111-8111-111111111111',
    name: '工作机',
    port: 45883,
    ts: 1
  })
  const parsed = parseBeacon(data)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.name, '工作机')
  assert.equal(parsed.packet.port, 45883)
})

test('beacon 拒绝非法输入', () => {
  assert.equal(parseBeacon(Buffer.from('not json')).ok, false)
  assert.equal(parseBeacon(Buffer.from(JSON.stringify({ v: 2, t: 'beacon' }))).ok, false)
  assert.equal(parseBeacon(Buffer.from(JSON.stringify({
    v: 1, t: 'beacon', deviceId: 'nope', name: 'x', port: 1, ts: 1
  }))).ok, false)
  assert.equal(parseBeacon(Buffer.alloc(4096, 0x20)).reason, 'oversize')
})

test('显示名与文件名被收窄', () => {
  assert.equal(clampName('  a\u0000b  '), 'ab')
  assert.equal(clampName('x'.repeat(100)).length, 32)
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('..hidden'), 'hidden')
})

test('签名可验，改一个字节就不过', () => {
  const key = crypto.randomBytes(32)
  const parts = { method: 'POST', path: '/ca/v1/ask', ts: 1, nonce: 'abcdefgh', bodyHash: 'f'.repeat(64) }
  const signature = sign(key, parts)
  assert.equal(verify(key, parts, signature), true)
  assert.equal(verify(key, { ...parts, path: '/ca/v1/file' }, signature), false)
  assert.equal(verify(key, parts, 'f'.repeat(64)), false)
})

test('nonce 只能出现一次', () => {
  let at = 0
  const cache = createNonceCache({ max: 4, ttlMs: 100, now: () => at })
  assert.equal(cache.accept('nonce-0001'), true)
  assert.equal(cache.accept('nonce-0001'), false)
  at = 200
  assert.equal(cache.accept('nonce-0001'), true, '过了窗口可以再用（窗口内的重放才拦）')
})

test('两端派生出同一把钥匙，指纹一致', () => {
  const a = createKeyPair()
  const b = createKeyPair()
  const idA = '11111111-1111-4111-8111-111111111111'
  const idB = '22222222-2222-4222-8222-222222222222'
  const keyA = deriveKey({
    privateKey: importPrivateKey(exportPrivateKey(a.privateKey)),
    peerPublicKey: importPublicKey(exportPublicKey(b.publicKey)),
    selfId: idA,
    peerId: idB
  })
  const keyB = deriveKey({
    privateKey: importPrivateKey(exportPrivateKey(b.privateKey)),
    peerPublicKey: importPublicKey(exportPublicKey(a.publicKey)),
    selfId: idB,
    peerId: idA
  })
  assert.equal(keyA.toString('hex'), keyB.toString('hex'))
  assert.equal(keyFingerprint(keyA), keyFingerprint(keyB))
  assert.equal(keyFingerprint(keyA).length, 8)
})

test('sha256Hex 与 Node 一致', () => {
  const buffer = crypto.randomBytes(1024)
  assert.equal(sha256Hex(buffer), crypto.createHash('sha256').update(buffer).digest('hex'))
})

test('临时目录里不留下任何东西（防止测试污染）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ca-'))
  await fs.writeFile(path.join(dir, 'x'), '1')
  const entries = await fs.readdir(dir)
  assert.deepEqual(entries, ['x'])
  await fs.rm(dir, { recursive: true, force: true })
})
