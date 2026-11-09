import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  INBOX_MAX_BYTES,
  INBOX_MAX_FILES,
  MAX_FILE_BYTES,
  safeFileName
} from './protocol.js'

/**
 * 文件传输：回执在**落盘并校验通过之后**才发出；没有回执就还在路上。
 *
 * 三条硬规则：同名不覆盖（加序号）、超限在读之前就拒、断流留下半截文件要删掉。
 */
export function createFiles ({
  store,
  rpc,
  audit,
  log,
  inboxRoot,
  shareRoot,
  shareRoots,
  now = () => Date.now()
} = {}) {
  const chunkDir = path.join(inboxRoot, '.tmp')

  function warn (message) {
    try {
      log?.warn?.(`[dsh-cross-agent] ${message}`)
    } catch {
      // ignore
    }
  }

  async function ensureDirs () {
    await fsp.mkdir(inboxRoot, { recursive: true, mode: 0o700 })
    await fsp.mkdir(chunkDir, { recursive: true, mode: 0o700 })
    for (const root of normalizeRoots(shareRoots ?? shareRoot)) {
      await fsp.mkdir(root, { recursive: true, mode: 0o700 }).catch(() => {})
    }
  }

  function dirFor (peerName) {
    const safe = safeFileName(peerName) || safeFileName('peer') || 'peer'
    return path.join(inboxRoot, safe)
  }

  async function uniquePath (dir, name) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const safe = safeFileName(name) || 'file'
    const ext = path.extname(safe)
    const stem = path.basename(safe, ext)
    let candidate = path.join(dir, safe)
    let index = 0
    while (true) {
      try {
        await fsp.access(candidate, fs.constants.F_OK)
      } catch {
        return candidate
      }
      index += 1
      candidate = path.join(dir, `${stem}(${index})${ext}`)
      if (index > 9999) throw new Error('同名文件太多，放弃编号')
    }
  }

  async function hashFile (absPath) {
    const stat = await fsp.stat(absPath)
    if (!stat.isFile()) throw new Error('不是普通文件')
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件太大：${stat.size} 字节，上限 ${MAX_FILE_BYTES}`)
    }
    const hash = crypto.createHash('sha256')
    await pipeline(fs.createReadStream(absPath), hash)
    return { size: stat.size, sha256: hash.digest('hex') }
  }

  async function inboxStats () {
    let bytes = 0
    let files = 0
    async function walk (dir) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === '.tmp') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        try {
          const stat = await fsp.stat(full)
          bytes += stat.size
          files += 1
        } catch {
          // 消失的文件不算
        }
      }
    }
    await walk(inboxRoot)
    return { bytes, files }
  }

  async function receive ({ peerId, peerName, name, size, sha256, transferId, stream }) {
    await ensureDirs()
    if (!Number.isFinite(size) || size < 0) throw httpFail(400, 'bad-size')
    if (size > MAX_FILE_BYTES) throw httpFail(413, 'too-large')
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw httpFail(400, 'bad-sha256')

    const stats = await inboxStats()
    if (stats.bytes + size > INBOX_MAX_BYTES) throw httpFail(507, 'inbox-full')
    if (stats.files + 1 > INBOX_MAX_FILES) throw httpFail(507, 'inbox-full')

    const temp = path.join(chunkDir, `${safeFileName(transferId) || crypto.randomUUID()}.part`)
    const hash = crypto.createHash('sha256')
    let received = 0

    const sink = fs.createWriteStream(temp, { mode: 0o600 })
    try {
      await pipeline(
        stream,
        async function * (source) {
          for await (const chunk of source) {
            received += chunk.length
            if (received > MAX_FILE_BYTES) throw httpFail(413, 'too-large')
            hash.update(chunk)
            yield chunk
          }
        },
        sink
      )
    } catch (error) {
      await fsp.rm(temp, { force: true })
      throw error
    }

    const digest = hash.digest('hex')
    if (received !== size) {
      await fsp.rm(temp, { force: true })
      throw httpFail(400, 'size-mismatch')
    }
    if (digest !== sha256.toLowerCase()) {
      await fsp.rm(temp, { force: true })
      throw httpFail(400, 'sha-mismatch')
    }

    const dir = dirFor(peerName)
    const target = await uniquePath(dir, name)
    await fsp.rename(temp, target)

    await record({
      peerId,
      direction: 'in',
      name: path.basename(target),
      size: received,
      sha256: digest,
      status: 'received'
    })
    await audit?.record({
      peerId,
      peerName,
      kind: 'transfer',
      outcome: 'received',
      detail: `${path.basename(target)} ${received} bytes`
    })

    return {
      ok: true,
      path: target,
      name: path.basename(target),
      size: received,
      sha256: digest,
      receivedAt: now()
    }
  }

  async function send ({ peerId, peerName, absPath, note = '' }) {
    const resolved = path.resolve(absPath)
    let stat
    try {
      stat = await fsp.stat(resolved)
    } catch {
      throw new Error(`找不到文件：${absPath}`)
    }
    if (!stat.isFile()) throw new Error('只能传普通文件（目录请先打包）')
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件太大：${stat.size} 字节`)

    const { sha256 } = await hashFile(resolved)
    const transferId = crypto.randomUUID()
    const fileName = path.basename(resolved)

    const begin = await rpc.call(peerId, 'POST', '/ca/v1/file/begin', {
      name: fileName,
      size: stat.size,
      sha256,
      transferId,
      note: String(note).slice(0, 200),
      waitMs: 60_000
    }, { timeoutMs: 75_000 })
    if (begin?.ok !== true) {
      const reason = begin?.reason ?? 'unknown'
      await record({ peerId, direction: 'out', name: fileName, size: stat.size, sha256, status: 'refused' })
      await audit?.record({
        peerId,
        peerName,
        kind: 'transfer',
        outcome: 'refused',
        detail: `${fileName} · ${reason}`
      })
      throw new Error(reason === 'awaiting-review' ? '对方还在审核这次传输，稍后再试' : `对方没有接受这次传输：${reason}`)
    }

    const verdict = await rpc.upload(peerId, '/ca/v1/file', {
      stream: fs.createReadStream(resolved),
      size: stat.size,
      sha256,
      headers: {
        'x-ca-name': encodeURIComponent(fileName),
        'x-ca-size': String(stat.size),
        'x-ca-sha256': sha256,
        'x-ca-transfer': transferId,
        'x-ca-wait': '120000',
        'x-ca-note': encodeURIComponent(String(note).slice(0, 200))
      }
    })

    await record({
      peerId,
      direction: 'out',
      name: fileName,
      size: stat.size,
      sha256,
      status: verdict?.ok === true ? 'delivered' : 'failed'
    })
    await audit?.record({
      peerId,
      peerName,
      kind: 'transfer',
      outcome: verdict?.ok === true ? 'sent' : 'failed',
      detail: `${fileName} ${stat.size} bytes`
    })

    return {
      ok: verdict?.ok === true,
      transferId,
      name: fileName,
      bytes: stat.size,
      sha256,
      receipt: verdict ?? null
    }
  }

  async function fetch ({ peerId, peerName, remotePath, destDir }) {
    const target = destDir ?? dirFor(peerName)
    await fsp.mkdir(target, { recursive: true, mode: 0o700 })

    const response = await rpc.download(peerId, `/ca/v1/file?path=${encodeURIComponent(remotePath)}`)
    const name = decodeURIComponent(String(response.headers['x-ca-name'] ?? path.basename(remotePath)))
    const size = Number(response.headers['x-ca-size'] ?? 0)
    const sha256 = String(response.headers['x-ca-sha256'] ?? '')
    if (size > MAX_FILE_BYTES) throw new Error('对方给的文件超过上限')

    const temp = path.join(chunkDir, `${crypto.randomUUID()}.part`)
    const hash = crypto.createHash('sha256')
    let received = 0
    try {
      await pipeline(
        response.stream,
        async function * (source) {
          for await (const chunk of source) {
            received += chunk.length
            hash.update(chunk)
            yield chunk
          }
        },
        fs.createWriteStream(temp, { mode: 0o600 })
      )
    } catch (error) {
      await fsp.rm(temp, { force: true })
      throw error
    }

    const digest = hash.digest('hex')
    if (sha256 !== '' && digest !== sha256) {
      await fsp.rm(temp, { force: true })
      throw new Error('sha256 不一致，文件已丢弃')
    }
    const finalPath = await uniquePath(target, name)
    await fsp.rename(temp, finalPath)

    await record({
      peerId,
      direction: 'in',
      name: path.basename(finalPath),
      size: received,
      sha256: digest,
      status: 'fetched'
    })
    await audit?.record({
      peerId,
      peerName,
      kind: 'transfer',
      outcome: 'fetched',
      detail: `${path.basename(finalPath)} ${received} bytes`
    })

    return { ok: true, path: finalPath, bytes: received, sha256: digest }
  }

  async function record (entry) {
    try {
      await store.appendBounded('transfers', { ...entry, at: now() }, 500)
    } catch {
      // 传输记录丢了不影响文件本身
    }
  }

  /**
   * 供对端拉取：只读**共享目录**（`.cross-agent/share/`）里的文件，绝不越界。
   * `relPath` 是相对共享目录的路径；`..`、绝对路径、符号链接逃逸一律拒绝。
   */
  async function openShared ({ shareRoots, relPath }) {
    if (typeof relPath !== 'string' || relPath.trim() === '') throw httpFail(400, 'bad-path')
    if (relPath.includes('\u0000')) throw httpFail(400, 'bad-path')
    const roots = normalizeRoots(shareRoots)
    if (roots.length === 0) throw httpFail(404, 'no-share')

    for (const root of roots) {
      const rootReal = await fsp.realpath(root).catch(() => null)
      if (rootReal === null) continue
      const wanted = path.resolve(rootReal, relPath)
      if (!contained(rootReal, wanted)) continue
      let real
      try {
        real = await fsp.realpath(wanted)
      } catch {
        continue
      }
      if (!contained(rootReal, real)) continue
      const stat = await fsp.stat(real).catch(() => null)
      if (stat === null || !stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) throw httpFail(413, 'too-large')
      const { sha256 } = await hashFile(real)
      return {
        stream: fs.createReadStream(real),
        name: path.basename(real),
        size: stat.size,
        sha256,
        root
      }
    }
    throw httpFail(404, 'not-found')
  }

  return {
    receive,
    send,
    fetch,
    openShared,
    hashFile,
    inboxStats,
    dirFor,
    get shareRoots () {
      return normalizeRoots(shareRoots ?? shareRoot)
    },
    transferId: () => crypto.randomUUID(),
    async recent (limit = 50) {
      try {
        return (await store.list('transfers')).slice(-limit).reverse()
      } catch {
        return []
      }
    },
    async init () {
      await ensureDirs()
      try {
        const entries = await fsp.readdir(chunkDir)
        for (const name of entries) await fsp.rm(path.join(chunkDir, name), { force: true })
      } catch {
        // 没权限就算了
      }
    }
  }
}

/** 白名单里的根目录：绝对路径直接用，相对路径相对工作目录。重复的收掉。 */
function normalizeRoots (value) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  const roots = []
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    const resolved = path.resolve(entry)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    roots.push(resolved)
  }
  return roots
}

function contained (root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function httpFail (status, reason) {
  const error = new Error(reason)
  error.status = status
  error.reason = reason
  return error
}
