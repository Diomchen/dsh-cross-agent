/**
 * 审计：一条有界的流水账，"谁、何时、对我们做了什么"。
 *
 * 只记事实，不判断对错。五类动作 + 一类拒绝：
 *   admit / mode / review / instruction / transfer / denied
 */
export const AUDIT_KINDS = ['admit', 'mode', 'review', 'instruction', 'transfer', 'session', 'denied']

export function createAudit ({ store, now = () => Date.now(), max = 1000 } = {}) {
  let seq = 0
  let loaded = false

  async function ensureLoaded () {
    if (loaded) return
    loaded = true
    try {
      const rows = await store.list('audit')
      seq = rows.reduce((acc, row) => Math.max(acc, Number(row.seq) || 0), 0)
    } catch {
      seq = 0
    }
  }

  async function record ({ peerId = null, peerName = null, kind, outcome = 'ok', detail = '' } = {}) {
    await ensureLoaded()
    if (!AUDIT_KINDS.includes(kind)) throw new Error(`audit: 未知的 kind ${kind}`)
    const entry = {
      seq: ++seq,
      at: now(),
      peerId,
      peerName,
      kind,
      outcome,
      detail: String(detail ?? '').slice(0, 500)
    }
    try {
      await store.appendBounded('audit', entry, max)
    } catch {
      // 审计坏掉不能反过来让业务失败
    }
    return entry
  }

  return {
    record,
    async recent (limit = 100) {
      await ensureLoaded()
      try {
        const rows = await store.list('audit')
        return rows.slice(-Math.max(1, limit)).reverse()
      } catch {
        return []
      }
    },
    get lastSeq () {
      return seq
    }
  }
}
