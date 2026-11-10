import dgram from 'node:dgram'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  BEACON_INTERVAL_MS,
  isUuid,
  DEFAULT_DISCOVERY_PORT,
  MAX_PACKET_BYTES,
  encodeBeacon,
  isPort,
  parseBeacon
} from './protocol.js'
import { createRateLimiter } from './limits.js'

/**
 * 局域网发现：UDP 广播 + 单播回执。这一层只做传输，不碰连接状态。
 *
 * - 收到合法 beacon：按 deviceId 记地址与广告端口，交给 onPacket；
 * - 对来源单播一条 ack（按源地址限速 1 条 / 4.5 秒，避免回执风暴）；
 * - 地址只在这里，通过 addressOf() 单独取，**绝不进面板快照**。
 *
 * 端口可注入、绑定地址可注入，所以单测可以在回环上跑两个真实 socket。
 */
export function createDiscovery ({
  identity,
  port = DEFAULT_DISCOVERY_PORT,
  servicePort,
  bindAddress = '0.0.0.0',
  broadcastAddress = '255.255.255.255',
  beaconIntervalMs = BEACON_INTERVAL_MS,
  /** 广播被挡的网段里，额外单播探这些地址（每拍一次），维持双方的"在线"心跳。 */
  probeTargets = [],
  registryDir = null,
  limits,
  onPacket,
  log,
  now = () => Date.now()
} = {}) {
  const endpoints = new Map()
  const inbound = limits?.inboundPacket ?? createRateLimiter({ windowMs: 10_000, max: 20, now })
  const acks = limits?.beaconAck ?? createRateLimiter({ windowMs: 4500, max: 1, now })
  let socket = null
  let timer = null
  let boundPort = 0
  let started = false
  let disposed = false
  let warnedBroadcast = false

  function warn (message) {
    try {
      log?.warn?.(message)
    } catch {
      // 日志不能把发现服务搞崩
    }
  }

  function advertisedPort () {
    if (Number.isInteger(servicePort) && servicePort > 0) return servicePort
    if (Number.isInteger(port) && port > 0) return port
    return boundPort
  }

  function packetFor (type) {
    return encodeBeacon({
      type,
      deviceId: identity.deviceId,
      name: identity.name,
      port: advertisedPort(),
      ts: now()
    })
  }

  function send (data, destinationPort, destinationAddress) {
    if (socket === null || !started || disposed) return
    socket.send(data, destinationPort, destinationAddress, (error) => {
      if (error && !warnedBroadcast) {
        warnedBroadcast = true
        warn('发现报文发不出去（网络可能不可用），对端列表会暂时不亮')
      }
    })
  }

  function sendBeacon () {
    if (socket === null || !started || disposed) return false
    try {
      send(packetFor('beacon'), advertisedPort(), broadcastAddress)
      return true
    } catch (error) {
      warn(`beacon 编码失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 同一台机器上跑两个 DSH 时，广播不一定能互相送到（同一个 UDP 端口上多个 socket，
   * 系统只把包交给其中一个；回环上的广播也常常不回来）。
   * 于是额外走一条"本机注册表"：每个实例每拍写一个小文件，顺手读别人的。
   * 这条通道只在本机有意义，地址固定 127.0.0.1；真机之间仍然靠广播。
   */
  async function announceLocal () {
    if (typeof registryDir !== 'string' || registryDir === '') return
    const file = path.join(registryDir, `${identity.deviceId}.json`)
    try {
      await fs.mkdir(registryDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(file, JSON.stringify({
        deviceId: identity.deviceId,
        name: identity.name,
        port: advertisedPort(),
        updatedAt: now()
      }), { mode: 0o600 })
    } catch {
      // 注册表写不了不影响广播
    }
  }

  async function scanLocal () {
    if (typeof registryDir !== 'string' || registryDir === '') return
    let entries
    try {
      entries = await fs.readdir(registryDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      let record
      try {
        record = JSON.parse(await fs.readFile(path.join(registryDir, entry), 'utf8'))
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object') continue
      if (!isUuid(record.deviceId) || record.deviceId === identity.deviceId) continue
      if (!isPort(record.port)) continue
      if (!Number.isFinite(record.updatedAt) || now() - record.updatedAt > 15_000) continue
      remember({ deviceId: record.deviceId, name: record.name, port: record.port }, '127.0.0.1', record.port)
      try {
        onPacket?.({
          type: 'beacon',
          deviceId: record.deviceId,
          name: typeof record.name === 'string' ? record.name : '',
          port: record.port,
          ts: record.updatedAt
        }, { address: '127.0.0.1', port: record.port, local: true })
      } catch {
        // ignore
      }
    }
  }

  async function tick () {
    sendBeacon()
    for (const target of probeTargets) probe(target.address, target.port)
    await announceLocal()
    await scanLocal()
  }

  /**
   * 单播探针：向一个已知地址发一条 beacon，让对端记住我们并回一条 ack。
   * 广播被 Wi-Fi（客户端隔离 / 广播抑制）挡住时的人工兜底——对端会把 ack
   * 单播回本 socket，`onMessage` 顺手把它的 deviceId / 名字 / 端口都记下来。
   * 默认发给对端的**发现端口**（和本机绑定的那个一致），不是 RPC 端口。
   */
  function probe (address, port = boundPort > 0 ? boundPort : advertisedPort()) {
    if (socket === null || !started || disposed) return false
    if (typeof address !== 'string' || address === '') return false
    if (!isPort(port)) return false
    try {
      send(packetFor('beacon'), port, address)
      return true
    } catch (error) {
      warn(`探针发不出去：${error?.message ?? error}`)
      return false
    }
  }

  function remember (packet, address, sourcePort) {
    const previous = endpoints.get(packet.deviceId)
    const port = packet.port > 0 ? packet.port : previous?.port ?? sourcePort
    endpoints.delete(packet.deviceId)
    endpoints.set(packet.deviceId, { address, port, name: packet.name, seenAt: now() })
    while (endpoints.size > 64) {
      const oldest = endpoints.keys().next()
      if (oldest.done) break
      endpoints.delete(oldest.value)
    }
  }

  function onMessage (buffer, rinfo) {
    if (disposed || !started) return
    const source = rinfo?.address
    if (typeof source !== 'string' || source === '') return
    if (!inbound.allow(source, now()).ok) return
    if (!(buffer instanceof Uint8Array) || buffer.length > MAX_PACKET_BYTES) return

    const parsed = parseBeacon(buffer)
    if (!parsed.ok) return
    const packet = parsed.packet
    if (packet.deviceId === identity.deviceId) return

    remember(packet, source, rinfo.port)

    try {
      onPacket?.(packet, { address: source, port: rinfo.port })
    } catch {
      // 回调坏掉不能把 socket 弄崩
    }

    if (packet.type === 'beacon' && acks.allow(source, now()).ok) {
      try {
        send(packetFor('ack'), rinfo.port, source)
      } catch {
        // 编码失败就这一拍不发
      }
    }
  }

  /**
   * 手工教发现层一个地址：单进程双实例的端到端、以及"广播被防火墙挡了"时的人工兜底。
   * 它不改变任何信任状态——只影响"往哪儿发"。
   */
  function learn (deviceId, { address, port } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return false
    if (typeof address !== 'string' || address === '' || !isPort(port)) return false
    const previous = endpoints.get(deviceId)
    endpoints.set(deviceId, { address, port, name: previous?.name ?? '', seenAt: now() })
    return true
  }

  function addressOf (deviceId) {
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return null
    return { address: endpoint.address, port: endpoint.port }
  }

  function isOnline (deviceId, ttlMs = 15_000) {
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return false
    return now() - endpoint.seenAt <= ttlMs
  }

  function snapshot () {
    return [...endpoints].map(([deviceId, endpoint]) => ({
      deviceId,
      name: endpoint.name,
      online: now() - endpoint.seenAt <= 15_000,
      lastSeenAt: endpoint.seenAt
    }))
  }

  async function start () {
    if (started) return { port: boundPort }
    if (disposed) throw new Error('discovery: disposed')
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket = sock
    sock.on('message', onMessage)
    sock.on('error', () => warn('发现服务的 socket 出错，对端列表可能不亮（本机功能不受影响）'))

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        sock.off('listening', onListening)
        sock.off('error', onError)
      }
      const onListening = () => {
        cleanup()
        resolve()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      sock.once('listening', onListening)
      sock.once('error', onError)
      try {
        sock.bind(port, bindAddress)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })

    boundPort = sock.address().port
    try {
      sock.setBroadcast(true)
    } catch {
      warn('系统不允许 UDP 广播，对端列表可能不亮')
    }
    sock.unref?.()
    started = true
    await tick()
    timer = setInterval(() => {
      tick().catch(() => {})
    }, Math.max(1000, beaconIntervalMs))
    timer.unref?.()
    return { port: boundPort }
  }

  function stop () {
    disposed = true
    started = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    inbound.clear()
    acks.clear()
    endpoints.clear()
    if (typeof registryDir === 'string' && registryDir !== '') {
      fs.rm(path.join(registryDir, `${identity.deviceId}.json`), { force: true }).catch(() => {})
    }
    if (socket !== null) {
      try {
        socket.off('message', onMessage)
        socket.close()
      } catch {
        // 已经关掉 / 没绑定过
      }
      socket = null
    }
  }

  return {
    start,
    stop,
    sendBeacon,
    probe,
    addressOf,
    learn,
    isOnline,
    snapshot,
    get port () {
      return boundPort
    }
  }
}
