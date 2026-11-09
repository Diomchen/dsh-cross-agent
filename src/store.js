import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 持久化的唯一入口。
 *
 * 先落一个 JSON 文件后端（零依赖、原子写、目录 0700），`storageDomain` 后端
 * 由票 01 的探针确认接口之后接进来——两条后端都必须满足同一组方法，
 * 上层只认 `get/put/delete/entries/size/appendBounded`。
 */
const LIST_TABLES = new Set(['audit', 'transfers'])

export async function createStore ({ dir, log, now = () => Date.now() }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tables = new Map()

  function fileOf (table) {
    return path.join(dir, `${table}.json`)
  }

  async function loadTable (table) {
    const existing = tables.get(table)
    if (existing !== undefined) return existing
    const pending = (async () => {
      let raw
      try {
        raw = await fs.readFile(fileOf(table), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`读取 ${table} 失败，按空表处理：${error.message}`)
        return emptyState(table)
      }
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.items)) return { map: new Map(), list: parsed.items }
        const map = new Map()
        for (const [key, value] of Object.entries(parsed?.items ?? {})) map.set(key, value)
        return { map, list: null }
      } catch {
        warn(`${table} 内容损坏，按空表处理`)
        return emptyState(table)
      }
    })()
    tables.set(table, pending)
    return pending
  }

  function emptyState (table) {
    return LIST_TABLES.has(table) ? { map: new Map(), list: [] } : { map: new Map(), list: null }
  }

  async function write (table, state) {
    const payload = state.list === null
      ? { v: 1, items: Object.fromEntries(state.map) }
      : { v: 1, items: state.list }
    const target = fileOf(table)
    const tmp = `${target}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
    await fs.rename(tmp, target)
  }

  function warn (message) {
    try {
      log?.warn?.(`[dsh-cross-agent] ${message}`)
    } catch {
      // 日志不能反过来把存储搞崩
    }
  }

  return {
    dir,

    async get (table, key) {
      const state = await loadTable(table)
      return state.list === null ? state.map.get(key) : undefined
    },

    async put (table, key, value) {
      const state = await loadTable(table)
      if (state.list !== null) throw new Error(`store: ${table} 是列表表，请用 appendBounded`)
      state.map.set(key, value)
      await write(table, state)
      return value
    },

    async delete (table, key) {
      const state = await loadTable(table)
      if (state.list !== null) throw new Error(`store: ${table} 是列表表`)
      if (!state.map.delete(key)) return false
      await write(table, state)
      return true
    },

    /** 返回 [{key, value}]；键序稳定（插入顺序），便于测试与展示。 */
    async entries (table) {
      const state = await loadTable(table)
      return [...state.map].map(([key, value]) => ({ key, value }))
    },

    async size (table) {
      const state = await loadTable(table)
      return state.list === null ? state.map.size : state.list.length
    },

    /** 环形表：追加并裁到 max 条，最旧的先走。 */
    async appendBounded (table, value, max = 1000) {
      const state = await loadTable(table)
      if (state.list === null) throw new Error(`store: ${table} 是键值表`)
      state.list.push(value)
      if (state.list.length > max) state.list.splice(0, state.list.length - max)
      await write(table, state)
      return value
    },

    async list (table) {
      const state = await loadTable(table)
      if (state.list === null) throw new Error(`store: ${table} 是键值表`)
      return [...state.list]
    },

    async replaceList (table, values) {
      const state = await loadTable(table)
      if (state.list === null) throw new Error(`store: ${table} 是键值表`)
      state.list = [...values]
      await write(table, state)
    },

    async close () {
      tables.clear()
    }
  }
}
