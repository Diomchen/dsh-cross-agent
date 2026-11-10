#!/usr/bin/env node
/**
 * 单机验收：假装自己是那个**已放行的对端**，给本机插件发一串带真实签名的请求，
 * 看它是不是还好好答话。升级完跑一遍即可，不需要第二台机器。
 *
 *   node scripts/smoke.mjs                # 只读：对端表 + 工具清单
 *   node scripts/smoke.mjs --security     # 再试一个不在白名单里的工具名（应 403）
 *   node scripts/smoke.mjs --full         # 再建一条会话 + 定向投递一句（会真的花一次 agent turn）
 *
 * 还能指定：--peer <名字|deviceId>  --port 45883  --dir <建会话用的目录>  --text <投递内容>
 *
 * 它读的是本机 `$DSH_HOME/dsh-cross-agent/data/` 里的身份与对端密钥——
 * 也就是"以已放行对端的身份说话"，这正是服务端认证要走的同一条路。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 || args[index + 1] === undefined ? fallback : args[index + 1]
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dataDir = path.join(home, 'dsh-cross-agent', 'data')
const port = Number(value('port', 45883))
const dir = value('dir', path.join(os.tmpdir(), 'dsh-cross-agent-smoke'))
const text = value('text', '冒烟测试：只回一句「收到」。')

const results = []
function record (name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

async function load () {
  const identity = JSON.parse(await fs.readFile(path.join(dataDir, 'identity.json'), 'utf8')).items.self
  const peers = JSON.parse(await fs.readFile(path.join(dataDir, 'peers.json'), 'utf8')).items
  const admitted = Object.values(peers).filter((row) => row?.state === 'admitted' && typeof row.key === 'string')
  if (admitted.length === 0) throw new Error('本机还没有已放行的对端；先在面板上放行一台再跑')
  const wanted = value('peer', '')
  const peer = wanted === ''
    ? admitted[0]
    : admitted.find((row) => row.deviceId === wanted || row.name === wanted)
  if (peer === undefined) throw new Error(`找不到已放行的对端：${wanted}`)
  return { identity, peer }
}

function request ({ identity, peer, method, path: route, body }) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8')
  const ts = Date.now()
  const nonce = crypto.randomBytes(16).toString('hex')
  const bodyHash = crypto.createHash('sha256').update(payload).digest('hex')
  const canonical = `${method}\n${route}\n${ts}\n${nonce}\n${bodyHash}`
  const signature = crypto.createHmac('sha256', Buffer.from(peer.key, 'base64')).update(canonical, 'utf8').digest('hex')

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: route,
      timeout: 300_000,
      headers: {
        'x-ca-device': peer.deviceId,
        'x-ca-ts': String(ts),
        'x-ca-nonce': nonce,
        'x-ca-sig': signature,
        'content-type': 'application/json',
        'content-length': String(payload.length),
        connection: 'close'
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = raw === '' ? null : JSON.parse(raw)
        } catch {
          json = null
        }
        resolve({ status: res.statusCode ?? 0, json, raw })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}

const { identity, peer } = await load()
console.log(`# 目标：${peer.name}（${peer.deviceId.slice(0, 8)}）→ 127.0.0.1:${port}`)

// 1. 工具清单：签名、时钟、放行三件事一起验
const tools = await request({ identity, peer, method: 'GET', path: '/ca/v1/tools' })
record('签名链路（GET /ca/v1/tools）', tools.status === 200 && tools.json?.ok === true, `HTTP ${tools.status}${tools.json?.reason ? ` · ${tools.json.reason}` : ''}`)

// 2. 白名单外的工具名必须被拒
if (flag('security')) {
  const denied = await request({
    identity, peer, method: 'POST', path: '/ca/v1/tool', body: { tool: '__smoke_not_exposed__', args: {}, waitMs: 5000 }
  })
  record('白名单外被拒（403 tool-not-exposed）', denied.status === 403 && denied.json?.reason === 'tool-not-exposed', `HTTP ${denied.status} · ${denied.json?.reason ?? ''}`)
}

// 3. 建会话 + 定向投递
if (flag('full')) {
  await fs.mkdir(dir, { recursive: true })
  const created = await request({
    identity, peer, method: 'POST', path: '/ca/v1/session/create', body: { path: dir, title: 'smoke', waitMs: 30_000 }
  })
  const sessionId = created.json?.sessionId
  record('远端建会话（/ca/v1/session/create）', created.status === 200 && created.json?.ok === true && typeof sessionId === 'string',
    `HTTP ${created.status}${created.json?.reason ? ` · ${created.json.reason}` : ` · ${sessionId ?? ''}`}`)

  if (typeof sessionId === 'string') {
    const asked = await request({
      identity, peer, method: 'POST', path: '/ca/v1/ask', body: { text, sessionId, waitMs: 180_000 }
    })
    const answered = asked.status === 200 && asked.json?.ok === true
    record('定向投递并拿到答复（/ca/v1/ask + sessionId）', answered,
      answered ? `reply=${JSON.stringify(asked.json.reply ?? '').slice(0, 40)}` : `HTTP ${asked.status} · ${asked.json?.reason ?? ''}`)

    const foreign = await request({
      identity, peer, method: 'POST', path: '/ca/v1/ask', body: { text: 'x', sessionId: 'session-smoke-not-mine', waitMs: 5000 }
    })
    record('投别人的会话被拒（403 session-not-allowed）', foreign.status === 403, `HTTP ${foreign.status} · ${foreign.json?.reason ?? ''}`)
  }
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}（${results.length} 项）`)
if (flag('full')) console.log(`提示：本次在 ${dir} 建了会话，演示完可以在面板里删掉。`)
process.exit(failed.length === 0 ? 0 : 1)
