/**
 * 本地 HTTP：给 Web UI 面板用的两个端点，挂在 DSH 自己的 webServer 上。
 *
 * 只接受回环地址的请求——这两个端点能放行对端、能同意指令，不能暴露到局域网。
 */
let currentService = null

/**
 * 注意这里用的是**模块级槽位**而不是闭包：插件被停用再启用时，宿主可能还挂着上一版的
 * 路由（重复注册会抛 duplicate prefix route）。让所有版本的 handler 都读"当前服务"，
 * 残留路由也能服务最新状态。
 */
export function registerLocalApi ({ webServer, service, log, path = '/cross-agent' } = {}) {
  if (webServer?.register === undefined) throw new Error('webServer 不可用')
  currentService = service

  const dispose = webServer.register({
    kind: 'prefix',
    path,
    handler: async (req, res) => {
      try {
        if (!isLoopback(req.socket?.remoteAddress)) {
          return send(res, 403, { ok: false, reason: 'loopback-only' })
        }
        const live = currentService
        if (live === null) return send(res, 503, { ok: false, reason: 'not-ready' })
        const url = splitUrl(req.url)
        if (req.method === 'GET' && (url.pathname === `${path}/state` || url.pathname === `${path}/state/`)) {
          return send(res, 200, { ok: true, state: await live.state() })
        }
        if (req.method === 'POST' && url.pathname === `${path}/action`) {
          const body = await readJson(req)
          const action = body?.action
          if (typeof action !== 'string' || action === '') return send(res, 400, { ok: false, reason: 'missing-action' })
          const result = await live.act(action, body ?? {})
          return send(res, 200, { ...result, state: await live.state() })
        }
        return send(res, 404, { ok: false, reason: 'not-found' })
      } catch (error) {
        log?.warn?.(`[dsh-cross-agent] 本地接口出错：${error?.message ?? error}`)
        return send(res, 500, { ok: false, reason: error?.message ?? 'internal' })
      }
    }
  })

  return () => {
    if (currentService === service) currentService = null
    try {
      dispose()
    } catch {
      // ignore
    }
  }
}

function isLoopback (address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function splitUrl (raw) {
  const value = typeof raw === 'string' ? raw : '/'
  const index = value.indexOf('?')
  return {
    pathname: index === -1 ? value : value.slice(0, index),
    search: index === -1 ? '' : value.slice(index)
  }
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

function send (res, status, json) {
  if (res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(json), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store'
  })
  res.end(payload)
}
