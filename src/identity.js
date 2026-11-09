import crypto from 'node:crypto'
import os from 'node:os'

import { clampName } from './protocol.js'

/**
 * 本机身份：deviceId、显示名、X25519 长期密钥。
 *
 * 它是"这台机器留在局域网里的持续部分"：删掉 identity 记录 = 换了一台机器，
 * 所有已放行的对端都会认不出来（这是设计意图，不是缺陷）。
 */
export function createIdentity ({ store, now = () => Date.now() } = {}) {
  let current = null

  async function load () {
    const record = await store.get('identity', 'self')
    if (record !== null && record !== undefined) {
      current = normalize(record)
      return current
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
    current = {
      deviceId: crypto.randomUUID(),
      name: defaultName(),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      createdAt: now()
    }
    await store.put('identity', 'self', current)
    return current
  }

  function normalize (record) {
    return {
      deviceId: record.deviceId,
      name: clampName(record.name) || defaultName(),
      publicKey: record.publicKey,
      privateKey: record.privateKey,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now()
    }
  }

  return {
    async open () {
      return load()
    },
    get () {
      return current
    },
    get deviceId () {
      return current?.deviceId ?? ''
    },
    get name () {
      return current?.name ?? ''
    },
    get publicKey () {
      return current?.publicKey ?? ''
    },
    get privateKey () {
      return current?.privateKey ?? ''
    },
    async rename (name) {
      const next = clampName(name)
      if (next === '') throw new Error('名字不能为空')
      current = { ...current, name: next }
      await store.put('identity', 'self', current)
      return current.name
    }
  }
}

function defaultName () {
  const host = safeHostname()
  return clampName(host) || 'DSH'
}

function safeHostname () {
  try {
    return (os.hostname() ?? '').replace(/\.local$/i, '')
  } catch {
    return ''
  }
}
