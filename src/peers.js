import {
  APPROVAL_TTL_MS,
  clampName,
  createNonce,
  deriveKey,
  importPrivateKey,
  importPublicKey,
  isUuid,
  keyFingerprint
} from './protocol.js'

/**
 * 连接表：本机对每个对端的认知（身份、状态、权限模式、共享密钥）。
 *
 * 状态机见 SPEC §5。这里只有三个入口会改变"能不能说话"：
 * `beginAdmission`（我请求）、`approve`（我同意）、`handleHelloConfirm`（对方确认）。
 * 其余动作（改模式、封禁、删除）都只影响本机这一侧。
 */
export function createPeers ({
  store,
  identity,
  audit,
  approvals,
  send,
  log,
  now = () => Date.now()
} = {}) {
  const records = new Map()

  function warn (message) {
    try {
      log?.warn?.(`[dsh-cross-agent] ${message}`)
    } catch {
      // ignore
    }
  }

  async function open () {
    const rows = await store.entries('peers')
    for (const { key, value } of rows) {
      if (isUuid(key)) records.set(key, normalize(value))
    }
    return records.size
  }

  function normalize (value) {
    return {
      deviceId: value.deviceId,
      name: clampName(value.name),
      publicKey: typeof value.publicKey === 'string' ? value.publicKey : null,
      key: typeof value.key === 'string' ? value.key : null,
      fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : null,
      state: ['discovered', 'pending', 'admitted', 'rejected', 'blocked'].includes(value.state)
        ? value.state
        : 'discovered',
      mode: value.mode === 'open' ? 'open' : 'confirm',
      createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now(),
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now(),
      admittedAt: Number.isFinite(value.admittedAt) ? value.admittedAt : null,
      blockedAt: Number.isFinite(value.blockedAt) ? value.blockedAt : null
    }
  }

  async function persist (record) {
    record.updatedAt = now()
    records.set(record.deviceId, record)
    await store.put('peers', record.deviceId, record)
    return record
  }

  function get (deviceId) {
    return records.get(deviceId) ?? null
  }

  function ensure (deviceId, name = '') {
    const existing = records.get(deviceId)
    if (existing !== undefined) {
      if (name !== '' && existing.name === '') existing.name = clampName(name)
      return existing
    }
    return normalize({
      deviceId,
      name,
      state: 'discovered',
      mode: 'confirm',
      createdAt: now()
    })
  }

  /** 面板视图：持久化的连接 + 只在发现层出现过的对端（合成一条 discovered）。 */
  function list ({ discovery } = {}) {
    const seen = new Map()
    if (discovery !== undefined) {
      for (const row of discovery.snapshot()) seen.set(row.deviceId, row)
    }
    const rows = [...records.values()].map((record) => view(record, seen))
    for (const row of seen.values()) {
      if (row.deviceId === identity.deviceId) continue
      if (records.has(row.deviceId)) continue
      rows.push({
        deviceId: row.deviceId,
        name: row.name || '未命名',
        state: 'discovered',
        mode: 'confirm',
        online: row.online,
        fingerprint: null,
        admittedAt: null,
        lastSeenAt: row.lastSeenAt
      })
    }
    return rows.sort((a, b) => {
      const rank = (row) => (row.state === 'admitted' ? 0 : row.state === 'pending' ? 1 : 2)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
  }

  function view (record, seen = new Map()) {
    const observed = seen.get(record.deviceId)
    return {
      deviceId: record.deviceId,
      name: record.name || '未命名',
      state: record.state,
      mode: record.mode,
      online: observed?.online === true,
      fingerprint: record.fingerprint,
      admittedAt: record.admittedAt,
      lastSeenAt: observed?.lastSeenAt ?? null
    }
  }

  function keyFor (deviceId) {
    const record = records.get(deviceId)
    if (record === undefined || record.key === null) return null
    return Buffer.from(record.key, 'base64')
  }

  function isAdmitted (deviceId) {
    return records.get(deviceId)?.state === 'admitted'
  }

  function modeOf (deviceId) {
    return records.get(deviceId)?.mode ?? 'confirm'
  }

  // ── 出站：我请求放行某个对端 ────────────────────────────────────────────

  async function beginAdmission (deviceId) {
    if (!isUuid(deviceId)) throw new Error('deviceId 不合法')
    const record = ensure(deviceId)
    if (record.state === 'blocked' || record.state === 'rejected') {
      throw new Error('这个对端已被拒绝或封禁，先解除再谈')
    }
    if (record.state === 'admitted') return { state: 'admitted', record }

    const response = await send(deviceId, 'POST', '/ca/v1/hello', {
      v: 1,
      deviceId: identity.deviceId,
      name: identity.name,
      pub: identity.publicKey,
      nonce: createNonce()
    }, { timeoutMs: 15_000, auth: false })

    if (response?.ok !== true) throw new Error(`对方没有接受握手：${response?.reason ?? 'unknown'}`)
    if (typeof response.pub === 'string' && response.pub !== '') record.publicKey = response.pub
    if (response.state === 'admitted') {
      // 对方已经放行过我：它会把 hello-confirm 发回来，这里不抢先
      record.state = record.state === 'admitted' ? 'admitted' : 'pending'
    } else {
      record.state = 'pending'
    }
    await persist(record)
    await audit?.record({
      peerId: deviceId,
      peerName: record.name,
      kind: 'admit',
      outcome: 'requested',
      detail: `state=${record.state}`
    })
    return { state: record.state, record }
  }

  // ── 入站：对方请求我放行 ────────────────────────────────────────────────

  async function handleHello (body, { source } = {}) {
    assertHello(body)
    if (body.deviceId === identity.deviceId) throw httpError(400, 'self')
    const record = ensure(body.deviceId, body.name)
    if (record.state === 'blocked') throw httpError(403, 'blocked')
    if (record.state === 'rejected') throw httpError(403, 'rejected')

    const wasAdmitted = record.state === 'admitted'
    record.publicKey = body.pub
    if (clampName(body.name) !== '') record.name = clampName(body.name)
    if (!wasAdmitted) record.state = 'pending'
    await persist(record)

    if (wasAdmitted) {
      await audit?.record({
        peerId: record.deviceId,
        peerName: record.name,
        kind: 'admit',
        outcome: 'repeat',
        detail: 'already admitted, re-confirming'
      })
      queueConfirmation(record.deviceId)
      return { ok: true, state: 'admitted', pub: identity.publicKey }
    }

    await approvals?.enqueue({
      kind: 'hello',
      peerId: record.deviceId,
      peerName: record.name,
      summary: `${record.name} 想建立跨端连接`,
      payload: { source: source ?? null, fingerprintOfPeer: null }
    })

    return { ok: true, state: 'pending', pub: identity.publicKey }
  }

  async function handleHelloConfirm (body, { context } = {}) {
    assertHello(body)
    if (body.deviceId === identity.deviceId) throw httpError(400, 'self')
    const record = ensure(body.deviceId, body.name)
    if (record.state === 'blocked' || record.state === 'rejected') throw httpError(403, 'blocked')

    const key = deriveFor(body.deviceId, body.pub)
    const derived = key.toString('base64')
    if (record.key !== null && record.key !== derived) {
      await audit?.record({
        peerId: record.deviceId,
        peerName: record.name,
        kind: 'denied',
        outcome: 'key-mismatch',
        detail: 'hello-confirm 派生出的密钥与已存的不同'
      })
      throw httpError(409, 'key-mismatch')
    }

    record.publicKey = body.pub
    record.key = derived
    record.fingerprint = keyFingerprint(key)
    record.state = 'admitted'
    record.admittedAt = record.admittedAt ?? now()
    if (record.name === '') record.name = clampName(body.name)
    await persist(record)

    await audit?.record({
      peerId: record.deviceId,
      peerName: record.name,
      kind: 'admit',
      outcome: 'confirmed',
      detail: `fingerprint=${record.fingerprint} via=${context?.verified ?? 'key'}`
    })

    return { ok: true, state: 'admitted' }
  }

  /** 人点了同意：派生密钥、落库 admitted、把 hello-confirm 发给对方。 */
  async function approve (deviceId) {
    const record = records.get(deviceId)
    if (record === undefined) throw new Error('没有这个对端')
    if (record.state === 'admitted') return view(record)
    if (typeof record.publicKey !== 'string' || record.publicKey === '') {
      throw new Error('还没有收到对方的公钥，等它的握手包到了再放行')
    }
    const key = deriveFor(deviceId, record.publicKey)
    record.key = key.toString('base64')
    record.fingerprint = keyFingerprint(key)
    record.state = 'admitted'
    record.admittedAt = now()
    await persist(record)
    await audit?.record({
      peerId: deviceId,
      peerName: record.name,
      kind: 'admit',
      outcome: 'approved',
      detail: `mode=${record.mode} fingerprint=${record.fingerprint}`
    })
    await approvals?.resolveByPeer(deviceId, 'hello', 'approved')
    try {
      await sendHelloConfirm(deviceId)
    } catch (error) {
      warn(`hello-confirm 没发出去（对方可能不在线）：${error?.message ?? error}`)
    }
    return view(record)
  }

  async function reject (deviceId) {
    const record = records.get(deviceId)
    if (record === undefined) throw new Error('没有这个对端')
    record.state = 'rejected'
    await persist(record)
    await audit?.record({ peerId: deviceId, peerName: record.name, kind: 'admit', outcome: 'rejected' })
    await approvals?.resolveByPeer(deviceId, 'hello', 'rejected')
    return view(record)
  }

  async function block (deviceId) {
    const record = ensure(deviceId)
    record.state = 'blocked'
    record.blockedAt = now()
    await persist(record)
    await audit?.record({ peerId: deviceId, peerName: record.name, kind: 'admit', outcome: 'blocked' })
    return view(record)
  }

  async function remove (deviceId) {
    records.delete(deviceId)
    await store.delete('peers', deviceId)
    await audit?.record({ peerId: deviceId, kind: 'admit', outcome: 'removed' })
    return true
  }

  async function setMode (deviceId, mode, { confirmed = false } = {}) {
    if (mode !== 'open' && mode !== 'confirm') throw new Error('mode 只能是 open 或 confirm')
    if (mode === 'open' && confirmed !== true) {
      throw new Error('改成完全开放需要二次确认')
    }
    const record = records.get(deviceId)
    if (record === undefined) throw new Error('没有这个对端')
    if (record.state !== 'admitted') throw new Error('这个对端还没放行，先放行再改模式')
    const previous = record.mode
    record.mode = mode
    await persist(record)
    await audit?.record({
      peerId: deviceId,
      peerName: record.name,
      kind: 'mode',
      outcome: mode,
      detail: `${previous} -> ${mode}`
    })
    return view(record)
  }

  async function sendHelloConfirm (deviceId) {
    const record = records.get(deviceId)
    if (record === undefined || record.key === null) throw new Error('还没有共享密钥')
    return send(deviceId, 'POST', '/ca/v1/hello-confirm', {
      v: 1,
      deviceId: identity.deviceId,
      name: identity.name,
      pub: identity.publicKey,
      nonce: createNonce()
    }, { timeoutMs: 15_000, derivedKey: keyFor(deviceId) })
  }

  function queueConfirmation (deviceId) {
    setTimeout(() => {
      sendHelloConfirm(deviceId).catch((error) => {
        warn(`补发 hello-confirm 失败：${error?.message ?? error}`)
      })
    }, 0)
  }

  function deriveFor (deviceId, publicKeyB64) {
    return deriveKey({
      privateKey: importPrivateKey(identity.privateKey),
      peerPublicKey: importPublicKey(publicKeyB64),
      selfId: identity.deviceId,
      peerId: deviceId
    })
  }

  return {
    open,
    list,
    get,
    view,
    ensure,
    keyFor,
    isAdmitted,
    modeOf,
    beginAdmission,
    handleHello,
    handleHelloConfirm,
    approve,
    reject,
    block,
    remove,
    setMode,
    sendHelloConfirm,
    get size () {
      return records.size
    }
  }
}

function assertHello (body) {
  if (body === null || typeof body !== 'object') throw httpError(400, 'bad-body')
  if (body.v !== 1) throw httpError(400, 'bad-version')
  if (!isUuid(body.deviceId)) throw httpError(400, 'bad-device-id')
  if (typeof body.pub !== 'string' || body.pub.length < 40 || body.pub.length > 200) {
    throw httpError(400, 'bad-public-key')
  }
  if (typeof body.nonce !== 'string' || body.nonce.length < 8) throw httpError(400, 'bad-nonce')
}

export function httpError (status, reason) {
  const error = new Error(reason)
  error.status = status
  error.reason = reason
  return error
}

export { APPROVAL_TTL_MS }
