import http from 'node:http'
import { pipeline } from 'node:stream/promises'

import {
  CLOCK_SKEW_MS,
  createNonceCache,
  createNonce,
  deriveKey,
  importPrivateKey,
  importPublicKey,
  sha256Hex,
  sign,
  verify
} from './protocol.js'

/**
 * 45883 上的 HTTP：一条请求一条连接的处理，没有长连接、没有 WebSocket。
 *
 * 认证靠 HMAC 请求签名（见 SPEC §4.2）。`/hello` 是唯一不需要签名的端点：
 * 那是"我们还不认识"时唯一能说的话。`/hello-confirm` 用**派生出来的密钥**验签，
 * 因为那时双方刚刚才第一次握有同一把钥匙。
 */

const MAX_JSON_BODY = 16 * 1024
const MAX_HEADER_BYTES = 32 * 1024

export function createRpcServer ({
  identity,
  port,
  peers,
  routes,
  limits,
  audit,
  clock,
  log,
  now = () => Date.now()
} = {}) {
  const nonces = createNonceCache({ now })
  const skewed = new Map()
  let server = null
  let boundPort = 0

  function warn (message) {
    try {
      log?.warn?.(message)
    } catch {
      // ignore
    }
  }

  /**
   * 时间窗：先是"按我们的钟算 ±60s"；不成立时再按"对端的钟"算一次
   * （见 src/clock.js）。后者只是把同一个窗口平移到对端，不会放宽。
   */
  function acceptTimestamp (deviceId, ts) {
    if (!Number.isFinite(ts)) return false
    if (clock === undefined || clock === null) return Math.abs(now() - ts) <= CLOCK_SKEW_MS
    if (!clock.accepts(deviceId, ts)) return false
    const absolute = Math.abs(now() - ts)
    if (absolute > CLOCK_SKEW_MS) noteSkew(deviceId, absolute)
    return true
  }

  /** 偏差本身不是错，但要让人看得见：一台没校时的机器不会自己变好。 */
  function noteSkew (deviceId, absolute) {
    const at = now()
    const previous = skewed.get(deviceId) ?? 0
    if (at - previous < 10 * 60_000) return
    skewed.set(deviceId, at)
    warn(`对端 ${deviceId} 的时钟与本机相差约 ${Math.round(absolute / 1000)} 秒，已按对端广播的时钟校验`)
  }

  function header (req, name) {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
  }

  async function authenticate (req, url, bodyBuffer, route) {
    const deviceId = header(req, 'x-ca-device')
    const ts = Number(header(req, 'x-ca-ts'))
    const nonce = header(req, 'x-ca-nonce')
    const signature = header(req, 'x-ca-sig')
    if (typeof deviceId !== 'string' || deviceId === '') throw fail(401, 'missing-device')
    if (!acceptTimestamp(deviceId, ts)) throw fail(401, 'clock-skew')
    if (typeof nonce !== 'string' || nonce.length < 8) throw fail(401, 'missing-nonce')
    if (typeof signature !== 'string') throw fail(401, 'missing-signature')

    let key
    if (route.auth === 'derive') {
      const record = peers.get(deviceId)
      if (record === null || typeof record.publicKey !== 'string') throw fail(401, 'unknown-peer')
      try {
        key = deriveKey({
          privateKey: importPrivateKey(identity.privateKey),
          peerPublicKey: importPublicKey(record.publicKey),
          selfId: identity.deviceId,
          peerId: deviceId
        })
      } catch {
        throw fail(401, 'bad-peer-key')
      }
    } else {
      key = peers.keyFor(deviceId)
      if (key === null) throw fail(401, 'not-admitted')
    }

    const bodyHash = route.stream === true
      ? (header(req, 'x-ca-bodyhash') ?? '')
      : sha256Hex(bodyBuffer)
    if (route.stream === true && bodyHash === '') throw fail(400, 'missing-bodyhash')

    const ok = verify(key, {
      method: req.method,
      path: url.path,
      ts,
      nonce,
      bodyHash
    }, signature)

    if (!ok) {
      await audit?.record({
        peerId: deviceId,
        kind: 'denied',
        outcome: 'bad-signature',
        detail: `${req.method} ${url.path}`
      })
      throw fail(401, 'bad-signature')
    }
    if (!nonces.accept(nonce)) throw fail(401, 'replayed')
    return { deviceId, peer: peers.get(deviceId) }
  }

  async function readBody (req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_JSON_BODY) throw fail(413, 'body-too-large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async function handle (req, res) {
    const url = splitUrl(req.url)
    try {
      const route = routes[`${req.method} ${url.pathname}`]
      if (route === undefined) {
        respond(res, 404, { ok: false, reason: 'not-found' })
        return
      }
      if (route.method !== undefined && route.method !== req.method) {
        respond(res, 405, { ok: false, reason: 'method' })
        return
      }

      const source = req.socket.remoteAddress ?? ''
      const sourceKey = `${source}`
      if (route.limit !== undefined) {
        const verdict = limits?.[route.limit]?.allow(sourceKey, now())
        if (verdict !== undefined && verdict.ok === false) {
          respond(res, 429, { ok: false, reason: 'rate-limited', retryAfterMs: verdict.retryAfterMs })
          return
        }
      }

      let body = null
      let buffer = Buffer.alloc(0)
      if (req.method === 'POST' && route.stream !== true) {
        buffer = await readBody(req)
        if (buffer.length > 0) {
          try {
            body = JSON.parse(buffer.toString('utf8'))
          } catch {
            throw fail(400, 'bad-json')
          }
        }
      }

      let auth = null
      if (route.auth !== 'none') {
        auth = await authenticate(req, url, buffer, route)
      }

      const result = await route.handler({
        req,
        res,
        url,
        body,
        buffer,
        auth,
        source,
        stream: route.stream === true
      })

      if (res.writableEnded) return
      if (result === undefined) {
        respond(res, 204, null)
        return
      }
      respond(res, result.status ?? 200, result.json ?? result)
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 500
      if (status >= 500) warn(`${req.method} ${req.url} 失败：${error?.message ?? error}`)
      if (!res.writableEnded) {
        respond(res, status, { ok: false, reason: error?.reason ?? 'internal' })
      }
    }
  }

  async function start () {
    server = http.createServer({
      requestTimeout: 0,
      headersTimeout: MAX_HEADER_BYTES,
      keepAliveTimeout: 5000
    }, (req, res) => {
      handle(req, res).catch(() => {
        if (!res.writableEnded) respond(res, 500, { ok: false, reason: 'internal' })
      })
    })
    server.on('clientError', (_error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        // ignore
      }
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
    boundPort = server.address().port
    return { port: boundPort }
  }

  async function stop () {
    nonces.clear()
    if (server === null) return
    const closing = server
    server = null
    try {
      // 先掐断还挂着的连接：否则 close() 要等到对端自己断开，插件永远卸不干净。
      closing.closeAllConnections?.()
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      closing.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    start,
    stop,
    get port () {
      return boundPort
    }
  }
}

export function createRpcClient ({ identity, peers, resolve, clock, log, now = () => Date.now() }) {
  function warn (message) {
    try {
      log?.warn?.(`[dsh-cross-agent] ${message}`)
    } catch {
      // ignore
    }
  }

  function signedHeaders ({ deviceId, method, path, bodyHash, keyHint }) {
    const key = keyHint ?? peers.keyFor(deviceId)
    if (key === null || key === undefined) throw new Error(`对端 ${deviceId} 还没有共享密钥（未放行）`)
    // 用**对端的钟**签：漏校时的对端只会拒绝按自己的钟算太远的请求。
    const ts = now() + (clock?.offsetFor(deviceId) ?? 0)
    const nonce = createNonce()
    const sig = sign(key, { method, path, ts, nonce, bodyHash })
    return {
      'x-ca-device': identity.deviceId,
      'x-ca-ts': String(ts),
      'x-ca-nonce': nonce,
      'x-ca-sig': sig
    }
  }

  function request (deviceId, { method, path, body, bodyHash, headers = {}, timeoutMs = 15_000, signal, derivedKey, auth = true }) {
    const endpoint = resolve(deviceId)
    if (endpoint === null) throw new Error('这个对端现在不在线')

    return new Promise((resolvePromise, rejectPromise) => {
      const payload = body === undefined || body === null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
      const hash = bodyHash ?? sha256Hex(payload)
      let signed = {}
      if (auth !== false) {
        try {
          signed = signedHeaders({ deviceId, method, path, bodyHash: hash, keyHint: derivedKey })
        } catch (error) {
          rejectPromise(error)
          return
        }
      }

      const req = http.request({
        host: endpoint.address,
        port: endpoint.port,
        method,
        path,
        headers: {
          ...signed,
          ...headers,
          'content-length': String(payload.length),
          connection: 'close'
        },
        timeout: timeoutMs
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json = null
          try {
            json = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'))
          } catch {
            json = null
          }
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, json, raw })
        })
      })

      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => rejectPromise(error))
      if (signal !== undefined) {
        if (signal.aborted) {
          req.destroy(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      req.end(payload)
    })
  }

  async function call (deviceId, method, path, body, options = {}) {
    let result = await request(deviceId, { method, path, body, ...options })
    if (result.status === 401 && result.json?.reason === 'clock-skew' && options.retryClockSkew !== false) {
      // 第一次打交道还不知道对端的钟走得快慢：从它的 Date 头学一次再试，
      // 免得每台没校时的机器都要人先去发现层等一个 beacon。
      if (clock?.observeDate?.(deviceId, result.headers) === true) {
        result = await request(deviceId, { method, path, body, ...options, retryClockSkew: false })
      }
    }
    if (result.status === 0) throw new Error('没有响应')
    if (result.status >= 400) {
      const reason = result.json?.reason ?? `HTTP ${result.status}`
      const error = new Error(reason)
      error.status = result.status
      error.reason = reason
      error.json = result.json
      throw error
    }
    return result.json
  }

  /** 上传：先算哈希（调用方算好传进来），再按流发一遍，避免把 100 MiB 读进内存。 */
  async function upload (deviceId, path, { stream, size, sha256, headers = {}, timeoutMs = 120_000 }) {
    const endpoint = resolve(deviceId)
    if (endpoint === null) throw new Error('这个对端现在不在线')
    const signed = signedHeaders({ deviceId, method: 'POST', path, bodyHash: sha256 })

    return new Promise((resolvePromise, rejectPromise) => {
      const req = http.request({
        host: endpoint.address,
        port: endpoint.port,
        method: 'POST',
        path,
        headers: {
          ...signed,
          ...headers,
          'x-ca-bodyhash': sha256,
          'content-length': String(size),
          'content-type': 'application/octet-stream',
          connection: 'close'
        },
        timeout: timeoutMs
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json = null
          try {
            json = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'))
          } catch {
            json = null
          }
          if ((res.statusCode ?? 0) >= 400) {
            const error = new Error(json?.reason ?? `HTTP ${res.statusCode}`)
            error.status = res.statusCode
            error.reason = json?.reason
            rejectPromise(error)
            return
          }
          resolvePromise(json)
        })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => rejectPromise(error))
      pipeline(stream, req).catch((error) => {
        warn(`上传流中断：${error?.message ?? error}`)
        rejectPromise(error)
      })
    })
  }

  /** 下载：拿到响应头之后把流交给调用方，由它自己落盘与校验。 */
  async function download (deviceId, path, { timeoutMs = 120_000 } = {}) {
    const endpoint = resolve(deviceId)
    if (endpoint === null) throw new Error('这个对端现在不在线')
    const signed = signedHeaders({ deviceId, method: 'GET', path, bodyHash: sha256Hex(Buffer.alloc(0)) })

    return await new Promise((resolvePromise, rejectPromise) => {
      const req = http.request({
        host: endpoint.address,
        port: endpoint.port,
        method: 'GET',
        path,
        headers: { ...signed, connection: 'close' },
        timeout: timeoutMs
      }, (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            let json = null
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              json = null
            }
            const error = new Error(json?.reason ?? `HTTP ${res.statusCode}`)
            error.status = res.statusCode
            rejectPromise(error)
          })
          return
        }
        resolvePromise({ headers: res.headers, stream: res })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => rejectPromise(error))
      req.end()
    })
  }

  return { call, upload, download, request }
}

function splitUrl (raw) {
  const value = typeof raw === 'string' ? raw : '/'
  const index = value.indexOf('?')
  const pathname = index === -1 ? value : value.slice(0, index)
  const search = index === -1 ? '' : value.slice(index)
  return { pathname, search, path: pathname + search }
}

function respond (res, status, json) {
  if (json === null || json === undefined) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end()
    return
  }
  const payload = Buffer.from(JSON.stringify(json), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length)
  })
  res.end(payload)
}

function fail (status, reason) {
  const error = new Error(reason)
  error.status = status
  error.reason = reason
  return error
}
