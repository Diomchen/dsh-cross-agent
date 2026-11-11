/**
 * Web UI 半侧：一个主面板（`main` 槽位）+ 一条常驻状态条（`shell.bottom`）。
 *
 * 设计按"人想知道什么"排：先回答"有没有事等我点头"，再回答"谁连着、它能对我做什么"，
 * 最后才是"刚才发生了什么"。所有判断都在宿主侧（`service.act`），这里不复制业务逻辑。
 *
 * 三条自我约束：
 *   1. 机器词（open / answered / transfer / session-not-mine）一律翻成人话，原始词只放进
 *      "展开"里的记录行，供排查时看。
 *   2. 空的区域不占卡片：没有待办就只留标题栏里的一行状态。
 *   3. 颜色只表达状态（在线/警告/失败），不用来区分方向或装饰。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cross-agent',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const POLL_MS = 3000
    const PAGE_SIZE = 30
    const PANEL_ID = 'cross-agent'
    const AUDIT_LIMIT = 100
    const TRANSFER_LIMIT = 50
    /** 侧栏与状态条都要能打开面板；`ctx.layout` 只有在这里拿得到。 */
    let runtime = null

    // ── 文案表：把宿主的机器词翻成人话 ────────────────────────────────────

    const REVIEW_KIND = {
      hello: { label: '连接请求', approve: '放行', consequence: '放行后，对端的 agent 就能向本机下达指令消息、传文件。新放行的连接默认「需要审核」。' },
      ask: { label: '指令消息', approve: '同意', consequence: '同意后，对方 agent 会在本机的跨端会话里执行这条指令，消耗本机一次 agent turn。' },
      file: { label: '文件', approve: '同意', consequence: '同意后，文件会落到本机收件箱；拒绝的话，对方会收到「没接受」。' },
      tool: { label: '工具调用', approve: '同意', consequence: '同意后，对方会用本机的权限执行这个工具，结果会发回给它。' },
      session: { label: '新建会话', approve: '同意', consequence: '同意后，会在那个目录下建一条会话；权限会被夹在本机允许的上限内。' }
    }

    const TRANSFER_OUTCOME = {
      delivered: { text: '已送达' },
      received: { text: '已收下' },
      fetched: { text: '已拉到本机' },
      refused: { text: '对方没接收', tone: 'warn' },
      failed: { text: '发送失败', tone: 'error' }
    }

    const INSTRUCTION_OUTCOME = {
      answered: { out: '已答复', in: '已回复', none: '已完成' },
      'no-reply': { out: '没等到答复', in: '没有回复', none: '没有答复', tone: 'warn' },
      failed: { out: '没送到', in: '没送到', none: '没送到', tone: 'error' },
      'tool-ok': { out: '工具调用完成', in: '工具执行完成', none: '工具调用完成' },
      'tool-failed': { out: '工具调用失败', in: '工具执行失败', none: '工具调用失败', tone: 'error' }
    }

    const DENIED_TEXT = {
      'bad-signature': '一条请求的签名对不上，已拒绝',
      'tool-not-exposed': (detail) => `试图调用没开放的工具「${detail || '?'}」`,
      'session-not-mine': '试图往不属于它的会话里投递',
      'sessions-disabled': '想新建会话，但本机没开这个能力',
      'key-mismatch': '密钥和之前记录的对不上',
      'clock-skew': '时间戳偏差太大，已拒绝'
    }

    const DENIED_CATEGORY = {
      'tool-not-exposed': 'instruction'
    }

    const ADMIT_TEXT = {
      requested: { text: '对端请求建立连接' },
      repeat: { text: '已放行的对端再次确认连接' },
      confirmed: { text: '连接握手完成' },
      approved: { text: '放行了这个对端' },
      rejected: { text: '拒绝了连接' },
      blocked: { text: '封禁了这个对端' },
      removed: { text: '移除了连接记录' }
    }

    const PRESET_TEXT = {
      'read-only': '只读',
      'workspace-write': '可写工作区',
      'danger-full-access': '完全访问'
    }

    // ── 小工具 ────────────────────────────────────────────────────────────

    function pad (n) {
      return String(n).padStart(2, '0')
    }

    function clockTime (at) {
      const date = new Date(at)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fullTime (at) {
      const date = new Date(at)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function dateOnly (at) {
      const date = new Date(at)
      return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`
    }

    function sameDay (a, b) {
      const x = new Date(a)
      const y = new Date(b)
      return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
    }

    function dayLabel (at, now) {
      if (sameDay(at, now)) return '今天'
      if (sameDay(at, now - 86400000)) return '昨天'
      const date = new Date(at)
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
      const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}年`
      return `${year}${dateOnly(at)} ${week}`
    }

    function relative (at, now) {
      const diff = Math.max(0, now - at)
      if (diff < 45000) return '刚刚'
      if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
      if (diff < 7 * 86400000) return `${Math.round(diff / 86400000)} 天前`
      return dateOnly(at)
    }

    function remaining (expiresAt, now) {
      const ms = expiresAt - now
      if (!Number.isFinite(ms)) return ''
      if (ms <= 0) return '已过期'
      if (ms < 60000) return '不到 1 分钟'
      if (ms < 3600000) return `${Math.ceil(ms / 60000)} 分钟`
      return `${Math.floor(ms / 3600000)} 小时`
    }

    function formatBytes (bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      const kb = bytes / 1024
      if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, '')} KB`
      return `${(kb / 1024).toFixed(1).replace(/\.0$/, '')} MB`
    }

    function shortId (id) {
      return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? '')
    }

    function firstLine (text) {
      const value = String(text ?? '')
      const index = value.indexOf('\n')
      return index === -1 ? value : value.slice(0, index)
    }

    async function copyText (text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 落到下面的兜底
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.append(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    // ── 状态：面板和状态条共用一份轮询 ────────────────────────────────────

    const remote = (() => {
      const listeners = new Set()
      let data = null
      let error = ''
      let inflight = null
      let timer = null
      let started = false

      function snapshot () {
        return { data, error }
      }

      function emit () {
        const value = snapshot()
        for (const listener of listeners) {
          try {
            listener(value)
          } catch {
            // 一个订阅者坏了不能拖累另一个
          }
        }
      }

      async function load () {
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const response = await fetch('/cross-agent/state', { headers: { accept: 'application/json' } })
            const json = await response.json().catch(() => null)
            if (!response.ok || json?.ok === false) {
              throw new Error(json?.reason ?? `HTTP ${response.status}`)
            }
            data = json?.state ?? null
            error = data === null ? '状态是空的' : ''
          } catch (cause) {
            error = cause?.message ?? String(cause)
          } finally {
            inflight = null
            emit()
          }
        })()
        return inflight
      }

      async function act (body) {
        const response = await fetch('/cross-agent/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        const json = await response.json().catch(() => null)
        if (!response.ok || json?.ok === false) {
          throw new Error(json?.reason ?? `HTTP ${response.status}`)
        }
        if (json?.state) {
          data = json.state
          error = ''
          emit()
        } else {
          await load()
        }
        return json
      }

      function onVisible () {
        if (document.visibilityState === 'visible') load()
      }

      function start () {
        if (started) return
        started = true
        load()
        timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          load()
        }, POLL_MS)
        document.addEventListener('visibilitychange', onVisible)
      }

      function stop () {
        started = false
        if (timer !== null) clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisible)
      }

      function subscribe (listener) {
        listeners.add(listener)
        if (listeners.size === 1) start()
        listener(snapshot())
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) stop()
        }
      }

      return { subscribe, act, load: () => load() }
    })()

    function useRemote () {
      const [snap, setSnap] = useState(() => ({ data: null, error: '' }))
      useEffect(() => remote.subscribe(setSnap), [])
      return snap
    }

    function useToast () {
      const [toast, setToast] = useState(null)
      const timer = useRef(null)
      const notify = useCallback((next) => {
        setToast({ id: Date.now(), ...next })
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setToast(null), 4000)
      }, [])
      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      return { toast, notify }
    }

    // ── 样式 ──────────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-cross-agent/panel.css'
    const PANEL_CSS = `
.ca-panel {
  --ca-text: var(--dsw-alias-label-primary, #e9e9ea);
  --ca-text-2: var(--dsw-alias-label-secondary, #a8a8ad);
  --ca-text-3: color-mix(in srgb, var(--dsw-alias-label-tertiary, #85858c) 72%, var(--dsw-alias-label-primary, #e9e9ea));
  --ca-line: var(--dsw-alias-border-l1, rgba(127,127,127,0.16));
  --ca-line-2: var(--dsw-alias-border-l2, rgba(127,127,127,0.28));
  --ca-surface: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06));
  --ca-surface-2: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1));
  --ca-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12));
  --ca-active: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18));
  --ca-ok: var(--dsw-alias-state-success-primary, #19b36b);
  --ca-warn: var(--dsw-alias-state-warn-primary, #f7ad31);
  --ca-bad: var(--dsw-alias-state-error-primary, #f25a5a);
  --ca-idle: var(--dsw-alias-state-idle-primary, #85858c);
  --ca-warn-text: color-mix(in srgb, var(--ca-warn) 65%, var(--ca-text));
  --ca-bad-text: color-mix(in srgb, var(--ca-bad) 70%, var(--ca-text));
  --ca-ok-text: color-mix(in srgb, var(--ca-ok) 60%, var(--ca-text));
  --ca-focus: var(--dsw-alias-brand-primary, #e9e9ea);
  height: 100%;
  overflow: auto;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--ca-text);
  font-family: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  scrollbar-gutter: stable;
}
.ca-panel *, .ca-panel *::before, .ca-panel *::after { box-sizing: border-box; }
.ca-panel :focus-visible { outline: 2px solid var(--ca-focus); outline-offset: 2px; }
.ca-inner { max-width: 960px; margin: 0 auto; padding: 20px 24px 36px; }

.ca-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ca-head-main { min-width: 0; flex: 1 1 220px; }
.ca-title { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.ca-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 4px; color: var(--ca-text-2); font-size: 12px; }
.ca-sub b { color: var(--ca-text); font-weight: 600; }
.ca-sep { color: var(--ca-text-3); }
.ca-head-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

.ca-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.ca-pill-ok { color: var(--ca-ok-text); background: color-mix(in srgb, var(--ca-ok) 12%, transparent); }
.ca-pill-warn { color: var(--ca-warn-text); background: color-mix(in srgb, var(--ca-warn) 15%, transparent); }

.ca-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid var(--ca-line-2);
  background: transparent;
  color: var(--ca-text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, opacity 0.14s ease;
}
.ca-btn:hover { background: var(--ca-hover); }
.ca-btn:active { background: var(--ca-active); }
.ca-btn:disabled { opacity: 0.45; cursor: default; }
.ca-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--ca-text)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #151517); font-weight: 600; }
.ca-btn-primary:hover { opacity: 0.88; background: var(--dsw-alias-button-primary-fill, var(--ca-text)); }
.ca-btn-ghost { border-color: transparent; color: var(--ca-text-2); }
.ca-btn-ghost:hover { color: var(--ca-text); }
.ca-btn-danger { border-color: transparent; color: var(--ca-bad-text); }
.ca-btn-danger:hover { border-color: color-mix(in srgb, var(--ca-bad) 32%, transparent); }
.ca-btn-sm { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 7px; }
.ca-icon-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ca-text-2); cursor: pointer; }
.ca-icon-btn:hover { background: var(--ca-hover); color: var(--ca-text); }
.ca-icon { flex: 0 0 auto; display: block; }

.ca-section { margin-top: 24px; }
.ca-h2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--ca-text-2); }
.ca-h2 .ca-count { font-weight: 500; letter-spacing: 0; color: var(--ca-text-3); font-variant-numeric: tabular-nums; }
.ca-h2 .ca-hint { margin-left: auto; font-weight: 400; letter-spacing: 0; color: var(--ca-text-3); font-size: 11.5px; }
.ca-empty { padding: 14px 16px; border: 1px dashed var(--ca-line-2); border-radius: 12px; color: var(--ca-text-3); font-size: 12.5px; line-height: 1.7; }
.ca-empty-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ca-empty-row .ca-btn { flex: 0 0 auto; }

/* 等你处理 */
.ca-need { border: 1px solid color-mix(in srgb, var(--ca-warn) 30%, var(--ca-line)); border-radius: 12px; overflow: hidden; background: color-mix(in srgb, var(--ca-warn) 4%, transparent); }
.ca-need-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; font-size: 12px; font-weight: 600; color: var(--ca-warn-text); background: color-mix(in srgb, var(--ca-warn) 7%, transparent); }
.ca-need-count { font-variant-numeric: tabular-nums; }
.ca-need-item { padding: 12px 14px; display: grid; gap: 9px; }
.ca-need-item + .ca-need-item { border-top: 1px solid color-mix(in srgb, var(--ca-warn) 14%, transparent); }
.ca-need-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--ca-text-3); }
.ca-need-peer { font-size: 12.5px; font-weight: 600; color: var(--ca-text); }
.ca-need-text { margin: 0; font-size: 13px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.ca-need-note { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--ca-text-2); }
.ca-need-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ca-check { display: inline-flex; align-items: center; gap: 6px; color: var(--ca-text-2); font-size: 11.5px; cursor: pointer; user-select: none; }
.ca-check input { width: 13px; height: 13px; margin: 0; accent-color: var(--ca-text); cursor: pointer; }

.ca-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11px; font-weight: 500; white-space: nowrap; color: var(--ca-text-2); background: var(--ca-surface-2); }
.ca-chip-warn { color: var(--ca-warn-text); background: color-mix(in srgb, var(--ca-warn) 14%, transparent); }

/* 连接 */
.ca-peer { border: 1px solid var(--ca-line); border-radius: 12px; background: var(--ca-surface); padding: 14px 16px; }
.ca-peer + .ca-peer { margin-top: 8px; }
.ca-peer-top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.ca-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.ca-dot-on { background: var(--ca-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ca-ok) 16%, transparent); }
.ca-dot-off { background: var(--ca-idle); }
.ca-dot-warn { background: var(--ca-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ca-warn) 16%, transparent); }
.ca-peer-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.ca-peer-original { color: var(--ca-text-3); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.ca-edit-btn { width: 24px; height: 24px; opacity: 0.55; }
.ca-peer-top:hover .ca-edit-btn, .ca-edit-btn:focus-visible, .ca-edit-btn[aria-expanded="true"] { opacity: 1; }
.ca-alias-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 9px; padding: 9px 10px; border: 1px solid var(--ca-line); border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 35%, transparent); }
.ca-alias-input { flex: 0 1 220px; min-width: 140px; height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid var(--ca-line-2); background: var(--dsw-alias-bg-base, transparent); color: var(--ca-text); font-family: inherit; font-size: 12.5px; }
.ca-alias-input::placeholder { color: var(--ca-text-3); }
.ca-alias-hint { flex: 1 0 100%; color: var(--ca-text-3); font-size: 11px; line-height: 1.6; }
.ca-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ca-inline-edit { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ca-inline-hint { color: var(--ca-text-3); font-size: 11px; }
.ca-inline-error { color: var(--ca-bad-text); font-size: 11px; }
.ca-peer-state { font-size: 11.5px; color: var(--ca-text-2); }
.ca-peer-state-on { color: var(--ca-ok-text); }
.ca-peer-meta { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; margin-top: 4px; color: var(--ca-text-3); font-size: 11.5px; }
.ca-peer-top .ca-peer-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.ca-peer-body { margin-top: 11px; display: grid; gap: 8px; }
.ca-mode { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--ca-line); border-radius: 9px; background: var(--dsw-alias-bg-base, transparent); width: fit-content; }
.ca-mode-btn { appearance: none; height: 24px; padding: 0 10px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ca-text-2); font-family: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer; transition: background 0.14s ease, color 0.14s ease; }
.ca-mode-btn:hover { color: var(--ca-text); background: var(--ca-hover); }
.ca-mode-btn[aria-pressed="true"] { background: var(--ca-surface-2); color: var(--ca-text); border-color: var(--ca-line); }
.ca-mode-btn[aria-pressed="true"].ca-mode-open { color: var(--ca-warn-text); background: color-mix(in srgb, var(--ca-warn) 14%, transparent); border-color: color-mix(in srgb, var(--ca-warn) 26%, transparent); }
.ca-mode-note { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--ca-text-2); }
.ca-mode-note-warn { color: var(--ca-warn-text); }

/* 活动 */
.ca-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.ca-filter { appearance: none; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: var(--ca-text-2); font-family: inherit; font-size: 12px; cursor: pointer; }
.ca-filter:hover { background: var(--ca-hover); color: var(--ca-text); }
.ca-filter[aria-pressed="true"] { background: var(--ca-surface-2); border-color: var(--ca-line); color: var(--ca-text); }
.ca-filter .ca-num { font-variant-numeric: tabular-nums; color: var(--ca-text-3); font-size: 11px; }
.ca-filter[aria-pressed="true"] .ca-num { color: var(--ca-text-2); }
.ca-filter:disabled { opacity: 0.4; cursor: default; }
.ca-filter-bad .ca-bad-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ca-bad); }
.ca-search { margin-left: auto; height: 26px; width: 180px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--ca-line); background: transparent; color: var(--ca-text); font-family: inherit; font-size: 12px; }
.ca-search::placeholder { color: var(--ca-text-3); }
.ca-search:focus { border-color: var(--ca-line-2); outline: 2px solid var(--ca-focus); outline-offset: 1px; }
.ca-day { margin-top: 16px; }
.ca-day:first-of-type { margin-top: 0; }
.ca-day-head { display: flex; align-items: center; gap: 8px; margin: 0 2px 6px; font-size: 11.5px; font-weight: 500; color: var(--ca-text-3); }
.ca-day-head .ca-num { font-variant-numeric: tabular-nums; }
.ca-feed { border: 1px solid var(--ca-line); border-radius: 12px; background: var(--ca-surface); overflow: hidden; }
.ca-ev { appearance: none; display: grid; grid-template-columns: 46px 74px minmax(0, 1fr) 64px 58px 14px; align-items: center; gap: 10px; width: 100%; padding: 7px 12px; border: 0; border-radius: 0; background: transparent; color: var(--ca-text); font-family: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.ca-ev-wrap + .ca-ev-wrap { border-top: 1px solid var(--ca-line); }
.ca-ev:hover { background: var(--ca-hover); }
.ca-ev-time { font-size: 12px; color: var(--ca-text-3); font-variant-numeric: tabular-nums; }
.ca-ev-chip { justify-self: start; font-size: 11.5px; color: var(--ca-text-3); white-space: nowrap; }
.ca-ev-chip-warn { color: var(--ca-warn-text); }
.ca-ev-chip-bad { color: var(--ca-bad-text); font-weight: 500; }
.ca-ev-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ca-text); }
.ca-ev-peer { margin-right: 6px; color: var(--ca-text-2); font-weight: 600; }
.ca-ev-out { font-size: 11.5px; color: var(--ca-text-3); text-align: right; white-space: nowrap; }
.ca-ev-out-warn { color: var(--ca-warn-text); }
.ca-ev-out-bad { color: var(--ca-bad-text); }
.ca-ev-meta { font-size: 11.5px; color: var(--ca-text-3); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ca-ev-chev { color: var(--ca-text-3); opacity: 0.7; display: flex; align-items: center; justify-content: center; }
.ca-ev:hover .ca-ev-chev { opacity: 1; }
.ca-ev-more { padding: 2px 14px 14px 70px; border-top: 1px dashed var(--ca-line); background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 45%, transparent); }
.ca-ev-full { margin: 10px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--ca-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.ca-kv { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 4px 12px; margin: 10px 0 0; font-size: 11.5px; }
.ca-kv dt { color: var(--ca-text-3); }
.ca-kv dd { margin: 0; color: var(--ca-text-2); overflow-wrap: anywhere; }
.ca-mono { font-family: var(--dsw-font-family-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)); font-size: 11px; }
.ca-more { appearance: none; display: block; width: 100%; height: 36px; margin-top: 10px; border: 1px dashed var(--ca-line-2); border-radius: 10px; background: transparent; color: var(--ca-text-2); font-family: inherit; font-size: 12px; cursor: pointer; }
.ca-more:hover { background: var(--ca-hover); color: var(--ca-text); }

/* 详情 */
.ca-details { margin-top: 14px; border: 1px solid var(--ca-line); border-radius: 12px; background: var(--ca-surface); padding: 14px 16px; }
.ca-facts { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 9px 14px; margin: 0; font-size: 12px; }
.ca-facts dt { color: var(--ca-text-3); }
.ca-facts dd { margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--ca-text-2); overflow-wrap: anywhere; }
.ca-tools { display: flex; flex-wrap: wrap; gap: 5px; }
.ca-tools:empty { display: none; }
.ca-tool { display: inline-flex; align-items: center; height: 19px; padding: 0 6px; border-radius: 5px; background: var(--ca-surface-2); color: var(--ca-text-2); font-family: var(--dsw-font-family-code, ui-monospace, Menlo, monospace); font-size: 11px; }

.ca-foot { margin-top: 22px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--ca-text-3); font-size: 11px; }
.ca-foot .ca-spacer { flex: 1; }
.ca-foot-path { max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ca-toast { position: fixed; left: 50%; bottom: 54px; z-index: 80; transform: translateX(-50%); max-width: min(480px, calc(100vw - 40px)); display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 10px; border: 1px solid var(--ca-line-2); background: var(--dsw-alias-bg-overlay, #2a2a2c); color: var(--ca-text); font-size: 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28); }
.ca-toast-bad { border-color: color-mix(in srgb, var(--ca-bad) 40%, transparent); }

.ca-error { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 9px; background: color-mix(in srgb, var(--ca-bad) 10%, transparent); color: var(--ca-bad-text); font-size: 12px; }
.ca-error .ca-spacer { flex: 1; }

/* 状态条 */
.ca-bar { --ca-text: var(--dsw-alias-label-primary, #e9e9ea); --ca-text-2: var(--dsw-alias-label-secondary, #a8a8ad); --ca-ok: var(--dsw-alias-state-success-primary, #19b36b); --ca-warn: var(--dsw-alias-state-warn-primary, #f7ad31); --ca-bad: var(--dsw-alias-state-error-primary, #f25a5a); --ca-idle: var(--dsw-alias-state-idle-primary, #85858c); --ca-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); appearance: none; display: inline-flex; align-items: center; gap: 7px; padding: 2px 9px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ca-text-2); font-family: inherit; font-size: 12px; line-height: 1.6; cursor: pointer; }
.ca-bar:hover { background: var(--ca-hover); color: var(--ca-text); }
.ca-bar:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #e9e9ea); outline-offset: 2px; }
.ca-bar-warn { color: color-mix(in srgb, var(--ca-warn) 65%, var(--ca-text)); }
.ca-bar-bad { color: color-mix(in srgb, var(--ca-bad) 70%, var(--ca-text)); }

@media (max-width: 760px) {
  .ca-inner { padding: 16px 14px 28px; }
  .ca-ev { grid-template-columns: 42px 68px minmax(0, 1fr) 58px 14px; }
  .ca-ev-meta { display: none; }
  .ca-ev-more { padding-left: 14px; }
  .ca-search { margin-left: 0; width: 100%; }
  .ca-peer-name { max-width: 200px; }
}
@media (max-width: 560px) {
  .ca-ev { grid-template-columns: 42px minmax(0, 1fr) 52px 14px; }
  .ca-ev-chip { display: none; }
  .ca-facts { grid-template-columns: 72px minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .ca-panel *, .ca-panel *::before, .ca-panel *::after { transition: none !important; scroll-behavior: auto !important; }
}
`
    function ensureStyle () {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', STYLE_ID)
      tag.textContent = PANEL_CSS
      document.head.append(tag)
    }

    // ── 图标 ──────────────────────────────────────────────────────────────

    function Svg ({ size = 14, children, ...rest }) {
      return h('svg', {
        className: 'ca-icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...rest
      }, children)
    }

    function ChevronDown ({ open, size = 14 }) {
      return h(Svg, { size, style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' } },
        h('path', { d: 'M4 6.5 8 10.5 12 6.5' }))
    }

    function CheckIcon () {
      return h(Svg, { size: 12 }, h('path', { d: 'M3 8.5 6.2 11.7 13 4.9' }))
    }

    function CopyIcon () {
      return h(Svg, { size: 12 }, h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }), h('path', { d: 'M10.5 5.5V3.7A1.2 1.2 0 0 0 9.3 2.5H3.7A1.2 1.2 0 0 0 2.5 3.7v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8' }))
    }

    function EditIcon () {
      return h(Svg, { size: 12 },
        h('path', { d: 'M11.3 2.7a1.6 1.6 0 0 1 2.2 2.2l-7.6 7.6-3 .8.8-3 7.6-7.6Z' }),
        h('path', { d: 'M9.8 4.2l2.2 2.2' }))
    }

    function RefreshIcon () {
      return h(Svg, { size: 13 }, h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }), h('path', { d: 'M13 2.5V5H10.5' }))
    }

    function CrossAgentIcon (owner = {}) {
      const size = Number.isFinite(owner?.size) ? owner.size : 16
      const stroke = { stroke: 'currentColor', strokeWidth: 4, fill: 'none', strokeLinecap: 'round' }
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', role: 'img', 'aria-hidden': 'true' },
        h('rect', { x: 4, y: 16, width: 20, height: 32, rx: 7, ...stroke }),
        h('rect', { x: 40, y: 16, width: 20, height: 32, rx: 7, ...stroke }),
        h('path', { d: 'M24 32h16', ...stroke }),
        h('circle', { cx: 14, cy: 32, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 50, cy: 32, r: 3.2, fill: 'currentColor' })
      )
    }

    // ── 活动流水：把审计行翻成一句话 ──────────────────────────────────────

    function baseEvent (row, key = row.seq) {
      return {
        key,
        at: row.at,
        peerId: row.peerId,
        peerName: row.peerName,
        peerAlias: '',
        raw: row,
        category: 'connection',
        label: '',
        chipTone: '',
        text: '',
        outcome: '',
        outTone: '',
        meta: '',
        detailFull: ''
      }
    }

    function transferEvent (row, peerName, peerAlias = '') {
      const inbound = row.direction === 'in'
      const outcome = TRANSFER_OUTCOME[row.status] ?? { text: row.status ?? '' }
      return {
        ...baseEvent({ at: row.at, peerId: row.peerId, peerName }, `t:${row.at}:${row.sha256 ?? row.name}`),
        peerAlias,
        category: 'file',
        label: inbound ? '收到文件' : '发出文件',
        text: row.name || '文件',
        outcome: outcome.text,
        outTone: outcome.tone ?? '',
        meta: formatBytes(row.size),
        detailFull: row.name || '',
        sha256: row.sha256 ?? '',
        raw: { kind: 'transfer', outcome: row.status }
      }
    }

    function toEvent (row) {
      const event = baseEvent(row)
      const detail = String(row.detail ?? '')

      if (row.kind === 'instruction') {
        const outbound = row.direction === 'out'
        const inbound = row.direction === 'in'
        const outcome = INSTRUCTION_OUTCOME[row.outcome] ?? {}
        const text = outcome.text ?? (outbound ? outcome.out : inbound ? outcome.in : (outcome.out ?? row.outcome))
        return {
          ...event,
          category: 'instruction',
          label: outbound ? '发出指令' : inbound ? '收到指令' : '指令',
          text: detail,
          outcome: text ?? row.outcome ?? '',
          outTone: outcome.tone ?? '',
          detailFull: detail
        }
      }

      if (row.kind === 'review') {
        // 同意过的结果由后面那条 instruction / transfer 记录体现；这里只留"人拒绝了"的痕迹
        if (row.outcome !== 'rejected') return null
        const kindId = String(detail).split(' ')[0]
        const kindText = { ask: '指令消息', file: '文件', tool: '工具调用', session: '新建会话', hello: '连接请求' }[kindId] ?? '请求'
        const category = kindId === 'file' ? 'file' : kindId === 'session' || kindId === 'hello' ? 'connection' : 'instruction'
        return {
          ...event,
          category,
          label: '审核',
          text: `你拒绝了一条${kindText}`,
          outcome: '已拒绝',
          outTone: '',
          detailFull: detail
        }
      }

      if (row.kind === 'denied') {
        const map = DENIED_TEXT[row.outcome]
        const text = typeof map === 'function' ? map(detail) : (map ?? (detail || row.outcome || '请求被拒绝'))
        return {
          ...event,
          category: DENIED_CATEGORY[row.outcome] ?? 'connection',
          label: '被拦下',
          chipTone: 'bad',
          text,
          outcome: '',
          outTone: 'error',
          detailFull: text
        }
      }

      if (row.kind === 'admit') {
        const known = ADMIT_TEXT[row.outcome]
        const fingerprint = /fingerprint=([0-9a-f]+)/.exec(detail)?.[1] ?? ''
        const mode = /mode=([a-z]+)/.exec(detail)?.[1] ?? ''
        const modeText = mode === 'open' ? '完全开放' : mode === 'confirm' ? '需要审核' : mode
        const suffix = [fingerprint !== '' ? `指纹 ${fingerprint}` : '', modeText !== '' ? modeText : ''].filter(Boolean).join(' · ')
        return {
          ...event,
          label: '连接',
          text: known?.text ?? (detail || row.outcome || '连接状态变化'),
          meta: suffix,
          detailFull: detail
        }
      }

      if (row.kind === 'mode') {
        const open = row.outcome === 'open'
        return {
          ...event,
          label: '权限',
          chipTone: open ? 'warn' : '',
          text: open ? '权限改成完全开放：对端的指令与文件直接生效' : '权限改回需要审核：每条都要你点头',
          outcome: open ? '风险变高' : '',
          outTone: open ? 'warn' : '',
          detailFull: detail
        }
      }

      if (row.kind === 'session') {
        const parts = detail.split(' · ')
        const dir = parts[0] ?? ''
        const title = parts[1] ?? ''
        const preset = parts[2] ?? ''
        return {
          ...event,
          label: '会话',
          text: title !== '' ? `在 ${dir} 建了会话「${title}」` : `建了会话 ${detail}`,
          meta: PRESET_TEXT[preset] ?? preset,
          detailFull: detail
        }
      }

      return {
        ...event,
        label: row.kind,
        text: detail || (row.outcome ?? ''),
        outcome: row.outcome ?? '',
        detailFull: detail
      }
    }

    // ── 面板 ──────────────────────────────────────────────────────────────

    function Panel () {
      const { data, error } = useRemote()
      const { toast, notify } = useToast()
      const [busy, setBusy] = useState('')
      const [openDetails, setOpenDetails] = useState(false)
      const [filter, setFilter] = useState('all')
      const [onlyBad, setOnlyBad] = useState(false)
      const [query, setQuery] = useState('')
      const [visible, setVisible] = useState(PAGE_SIZE)
      const now = Date.now()

      const run = useCallback(async (key, body, done) => {
        setBusy(key)
        try {
          await remote.act(body)
          if (done) notify({ tone: 'ok', text: done })
          return true
        } catch (cause) {
          notify({ tone: 'error', text: cause?.message ?? String(cause) })
          return false
        } finally {
          setBusy('')
        }
      }, [notify])

      const peers = data?.peers ?? []
      const pending = useMemo(
        () => (data?.pending ?? [])
          .filter((item) => item.status !== 'expired' && (item.expiresAt == null || item.expiresAt > now))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
        [data?.pending, now]
      )
      const aliasOf = useMemo(() => {
        const map = new Map()
        for (const peer of data?.peers ?? []) {
          if (typeof peer.alias === 'string' && peer.alias !== '') map.set(peer.deviceId, peer.alias)
        }
        return map
      }, [data?.peers])

      const events = useMemo(() => {
        const peersById = new Map((data?.peers ?? []).map((peer) => [peer.deviceId, peer]))
        // 对端记录被移除后，transfers 里只剩 peerId；从审计里找回当时的显示名
        const names = new Map()
        for (const row of data?.audit ?? []) {
          if (row.peerId && row.peerName) names.set(row.peerId, row.peerName)
        }
        for (const [deviceId, peer] of peersById) names.set(deviceId, peer.name)
        const rows = []
        // 文件事件用 transfers 表（带 sha256、方向、状态，而且不受 100 条审计窗口限制）
        for (const transfer of data?.transfers ?? []) {
          const peer = peersById.get(transfer.peerId)
          rows.push(transferEvent(transfer, peer?.name ?? names.get(transfer.peerId) ?? '', peer?.alias ?? ''))
        }
        for (const row of data?.audit ?? []) {
          if (row.kind === 'transfer') continue // 同一件事已经在 transfers 里了
          const event = toEvent(row)
          if (event === null) continue
          event.peerAlias = aliasOf.get(event.peerId) ?? ''
          rows.push(event)
        }
        return rows.sort((a, b) => b.at - a.at)
      }, [data?.transfers, data?.audit, data?.peers, aliasOf])

      const counts = useMemo(() => {
        const value = { all: events.length, instruction: 0, file: 0, connection: 0, bad: 0 }
        for (const event of events) {
          if (value[event.category] !== undefined) value[event.category] += 1
          if (event.outTone === 'error' || event.chipTone === 'bad') value.bad += 1
        }
        return value
      }, [events])

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        return events.filter((event) => {
          if (filter !== 'all' && event.category !== filter) return false
          if (onlyBad && !(event.outTone === 'error' || event.chipTone === 'bad')) return false
          if (needle === '') return true
          const hay = [event.text, event.peerName, event.peerAlias, event.outcome, event.meta, event.label].filter(Boolean).join(' ').toLowerCase()
          return hay.includes(needle)
        })
      }, [events, filter, onlyBad, query])

      useEffect(() => {
        setVisible(PAGE_SIZE)
      }, [filter, onlyBad, query])

      useEffect(() => {
        if (onlyBad && counts.bad === 0) setOnlyBad(false)
      }, [onlyBad, counts.bad])

      const shown = filtered.slice(0, visible)
      const groups = useMemo(() => {
        const list = []
        let previousPeer = ''
        for (const event of shown) {
          const label = dayLabel(event.at, now)
          let group = list[list.length - 1]
          if (group === undefined || group.label !== label) {
            group = { label, items: [] }
            list.push(group)
            previousPeer = ''
          }
          // 同一个对端连着出现时只在第一条上写名字，别让一列名字盖过内容
          const showPeer = event.peerId != null && event.peerId !== previousPeer
          if (event.peerId != null) previousPeer = event.peerId
          group.items.push({ ...event, showPeer })
        }
        return list
      }, [shown, now])

      if (data === null) {
        return h('div', { className: 'ca-panel' },
          h('div', { className: 'ca-inner' },
            h('div', { className: 'ca-head' }, h('div', { className: 'ca-head-main' }, h('h2', { className: 'ca-title' }, '跨端 agent'))),
            h('div', { className: 'ca-section' }, h('div', { className: 'ca-empty' },
              error === ''
                ? '正在读取跨端状态…'
                : h('div', { className: 'ca-empty-row' },
                  h('span', null, `读不到跨端状态：${error}。插件可能刚被停用，或本地接口还没起来。`),
                  h('button', { type: 'button', className: 'ca-btn ca-btn-sm', onClick: () => remote.load() }, '重试'))))
          )
        )
      }

      const self = data.self ?? {}
      const admitted = peers.filter((peer) => peer.state === 'admitted')
      const online = admitted.filter((peer) => peer.online).length
      const liveHelloPeers = new Set(pending.filter((item) => item.kind === 'hello').map((item) => item.peerId))
      const ports = data.ports ?? {}
      const paths = data.paths ?? {}
      const exposed = data.capabilities?.exposedTools ?? []

      return h('div', { className: 'ca-panel' },
        h('div', { className: 'ca-inner' },
          // 顶部：本机是谁、有没有事等你
          h('header', { className: 'ca-head' },
            h('div', { className: 'ca-head-main' },
              h('h2', { className: 'ca-title' }, '跨端 agent'),
              h('div', { className: 'ca-sub' },
                h('span', null, '本机 ', h('b', null, self.name || shortId(self.deviceId) || '这台机器')),
                h('span', { className: 'ca-sep' }, '·'),
                h('span', null, admitted.length === 0
                  ? '还没有连接'
                  : `${admitted.length} 条连接（${online} 在线）`),
                exposed.length > 0
                  ? h(React.Fragment, null,
                    h('span', { className: 'ca-sep' }, '·'),
                    h('span', { className: 'ca-chip ca-chip-warn', title: '对端可以调用这些本机工具' }, `开放工具 ${exposed.length}`))
                  : null
              )
            ),
            h('div', { className: 'ca-head-actions' },
              pending.length > 0
                ? h('span', { className: 'ca-pill ca-pill-warn' }, h('span', { className: 'ca-dot ca-dot-warn' }), `${pending.length} 件等你处理`)
                : h('span', { className: 'ca-pill ca-pill-ok' }, h(CheckIcon), '没有待办'),
              h('button', {
                type: 'button',
                className: 'ca-btn ca-btn-ghost ca-btn-sm',
                'aria-expanded': openDetails,
                'aria-controls': 'ca-details',
                onClick: () => setOpenDetails((value) => !value)
              }, '详情', h(ChevronDown, { open: openDetails, size: 12 }))
            )
          ),

          error !== ''
            ? h('div', { className: 'ca-section' },
              h('div', { className: 'ca-error', role: 'alert' }, h('span', null, `状态没刷新：${error}`), h('span', { className: 'ca-spacer' }),
                h('button', { type: 'button', className: 'ca-btn ca-btn-ghost ca-btn-sm', onClick: () => remote.load() }, '重试')))
            : null,

          openDetails
            ? h(Details, { id: 'ca-details', self, ports, paths, exposed, startedAt: data.startedAt, notify, busy, run })
            : null,

          // 需要你点头的事：有才出现
          pending.length > 0
            ? h('section', { className: 'ca-section', id: 'ca-review' },
              h('div', { className: 'ca-need' },
                h('div', { className: 'ca-need-head' },
                  h('span', null, '需要你决定'),
                  h('span', { className: 'ca-need-count' }, `${pending.length} 件`)
                ),
                pending.map((item) => h(ReviewItem, { key: item.id, item, now, busy, run, displayPeer: aliasOf.get(item.peerId) || item.peerName || shortId(item.peerId) }))
              ))
            : null,

          // 连接：谁连着、它能对我做什么
          h('section', { className: 'ca-section' },
            h('h3', { className: 'ca-h2' }, '对端', h('span', { className: 'ca-count' }, peers.length),
              h('span', { className: 'ca-hint' }, '放行过的对端才能向本机下指令')),
            peers.length === 0
              ? h('div', { className: 'ca-empty' }, '局域网上还没看到对端。确认两台机器在同一网段，并且防火墙放行 UDP 45881。')
              : peers.map((peer) => h(PeerCard, {
                key: peer.deviceId,
                peer,
                now,
                busy,
                run,
                hasLiveHello: liveHelloPeers.has(peer.deviceId)
              }))
          ),

          // 活动：发生了什么
          h('section', { className: 'ca-section' },
            h('h3', { className: 'ca-h2' }, '活动', h('span', { className: 'ca-count' }, counts.all),
              h('button', {
                type: 'button',
                className: 'ca-icon-btn',
                title: '立即刷新',
                'aria-label': '立即刷新',
                onClick: () => remote.load()
              }, h(RefreshIcon)),
              h('span', { className: 'ca-hint' }, '由近到远 · 点一条看细节')
            ),
            events.length === 0
              ? h('div', { className: 'ca-empty' }, '还没有往来记录。对端放行之后，指令消息和文件会记在这里。')
              : h(React.Fragment, null,
                h('div', { className: 'ca-toolbar', role: 'group', 'aria-label': '筛选活动' },
                  [
                    ['all', '全部'],
                    ['instruction', '指令'],
                    ['file', '文件'],
                    ['connection', '连接']
                  ].map(([id, label]) => h('button', {
                    key: id,
                    type: 'button',
                    className: 'ca-filter',
                    'aria-pressed': filter === id,
                    onClick: () => setFilter(id)
                  }, label, h('span', { className: 'ca-num' }, counts[id]))),
                  h('button', {
                    type: 'button',
                    className: 'ca-filter ca-filter-bad',
                    'aria-pressed': onlyBad,
                    disabled: counts.bad === 0,
                    title: '只看被拒绝、失败这类需要留意的记录',
                    onClick: () => setOnlyBad((value) => !value)
                  }, h('span', { className: 'ca-bad-dot' }), '只看异常', h('span', { className: 'ca-num' }, counts.bad)),
                  h('input', {
                    className: 'ca-search',
                    type: 'search',
                    value: query,
                    placeholder: '搜索别名、对端或内容',
                    'aria-label': '搜索活动',
                    onChange: (event) => setQuery(event.target.value)
                  })
                ),
                filtered.length === 0
                  ? h('div', { className: 'ca-empty' }, '没有符合条件的记录。')
                  : groups.map((group) => h('section', { className: 'ca-day', key: group.label },
                    h('div', { className: 'ca-day-head' }, group.label, h('span', { className: 'ca-num' }, `${group.items.length} 条`)),
                    h('div', { className: 'ca-feed' },
                      group.items.map((event) => h(EventRow, { key: event.key, event, multiPeer: peers.length > 1 }))
                    )
                  )),
                filtered.length > shown.length
                  ? h('button', {
                    type: 'button',
                    className: 'ca-more',
                    onClick: () => setVisible((value) => value + PAGE_SIZE)
                  }, `显示更早的 ${Math.min(PAGE_SIZE, filtered.length - shown.length)} 条`)
                  : null
              )
          ),

          h('footer', { className: 'ca-foot' },
            h('span', null, `每 ${POLL_MS / 1000} 秒自动刷新`),
            h('span', { className: 'ca-sep' }, '·'),
            h('span', null, `审计保留 ${AUDIT_LIMIT} 条 · 传输保留 ${TRANSFER_LIMIT} 条`),
            h('span', { className: 'ca-spacer' }),
            paths.inbox ? h('span', { className: 'ca-foot-path', title: paths.inbox }, `收到的文件在 ${paths.inbox}`) : null
          )
        ),

        toast !== null
          ? h('div', { className: `ca-toast${toast.tone === 'error' ? ' ca-toast-bad' : ''}`, role: toast.tone === 'error' ? 'alert' : 'status' },
            toast.tone === 'error' ? null : h(CheckIcon),
            h('span', null, toast.text))
          : null
      )
    }

    // ── 待审核卡片 ────────────────────────────────────────────────────────

    function ReviewItem ({ item, now, busy, run, displayPeer }) {
      const [remember, setRemember] = useState(false)
      const kind = REVIEW_KIND[item.kind] ?? { label: item.kind, approve: '同意', consequence: '' }
      const left = remaining(item.expiresAt, now)
      const tight = item.expiresAt - now < 10 * 60000
      const key = `review:${item.id}`

      return h('div', { className: 'ca-need-item' },
        h('div', { className: 'ca-need-meta' },
          h('span', { className: 'ca-chip ca-chip-warn' }, kind.label),
          h('span', { className: 'ca-need-peer', title: item.peerName || '' }, displayPeer),
          h('span', null, relative(item.createdAt, now)),
          left !== '' ? h('span', { className: 'ca-sep' }, '·') : null,
          left !== '' ? h('span', { style: tight ? { color: 'var(--ca-warn-text)' } : undefined }, `还剩 ${left}`) : null
        ),
        h('p', { className: 'ca-need-text' }, item.summary || '（对方没有附带说明）'),
        kind.consequence !== '' ? h('p', { className: 'ca-need-note' }, kind.consequence) : null,
        h('div', { className: 'ca-need-actions' },
          h('button', {
            type: 'button',
            className: 'ca-btn ca-btn-primary',
            disabled: busy !== '',
            onClick: () => run(key, { action: 'approve', id: item.id, remember: item.kind === 'hello' ? false : remember }, `${kind.approve}了`)
          }, busy === key ? '处理中…' : kind.approve),
          h('button', {
            type: 'button',
            className: 'ca-btn',
            disabled: busy !== '',
            onClick: () => run(`reject:${item.id}`, { action: 'reject', id: item.id }, '已拒绝')
          }, '拒绝'),
          item.kind === 'hello'
            ? null
            : h('label', { className: 'ca-check' },
              h('input', {
                type: 'checkbox',
                checked: remember,
                onChange: (event) => setRemember(event.target.checked)
              }),
              '24 小时内同类不再问'
            )
        )
      )
    }

    // ── 连接卡片 ──────────────────────────────────────────────────────────

    function PeerCard ({ peer, now, busy, run, hasLiveHello }) {
      const admitted = peer.state === 'admitted'
      const mode = peer.mode === 'open' ? 'open' : 'confirm'
      const key = `peer:${peer.deviceId}`
      const aliasKey = `${key}:alias`
      const alias = typeof peer.alias === 'string' ? peer.alias : ''
      const display = alias || peer.name || shortId(peer.deviceId)
      const [editingAlias, setEditingAlias] = useState(false)
      const [aliasDraft, setAliasDraft] = useState(alias)
      const aliasInput = useRef(null)
      const editButton = useRef(null)

      useEffect(() => {
        if (!editingAlias) return
        const input = aliasInput.current
        if (input !== null) {
          input.focus()
          input.select()
        }
      }, [editingAlias])

      const beginAlias = useCallback(() => {
        setAliasDraft(alias)
        setEditingAlias(true)
      }, [alias])

      // 收起编辑器后把焦点还给铅笔，键盘用户不用从头 Tab
      const closeAlias = useCallback(() => {
        setEditingAlias(false)
        setTimeout(() => editButton.current?.focus(), 0)
      }, [])

      const saveAlias = useCallback(async (next) => {
        const typed = String(next ?? '').trim()
        // 和显示名一样就等于没起别名，别在卡片上留两遍同一个名字
        const value = typed === (peer.name || '') ? '' : typed
        const done = await run(aliasKey, { action: 'alias', deviceId: peer.deviceId, alias: value },
          value === '' ? '已清除别名' : `别名已设为「${value}」`)
        if (done) closeAlias()
      }, [aliasKey, peer.deviceId, peer.name, run, closeAlias])

      const actions = []

      if (peer.state === 'discovered') {
        actions.push(h('button', {
          key: 'connect',
          type: 'button',
          className: 'ca-btn ca-btn-primary ca-btn-sm',
          disabled: busy !== '',
          onClick: () => run(`${key}:connect`, { action: 'connect', deviceId: peer.deviceId }, '连接请求已发出')
        }, busy === `${key}:connect` ? '请求中…' : '请求连接'))
      }

      if (peer.state === 'pending' && !hasLiveHello) {
        actions.push(h('button', {
          key: 'allow',
          type: 'button',
          className: 'ca-btn ca-btn-primary ca-btn-sm',
          disabled: busy !== '',
          onClick: () => run(`${key}:allow`, { action: 'allow-peer', deviceId: peer.deviceId }, '已放行')
        }, '放行'))
        actions.push(h('button', {
          key: 'deny',
          type: 'button',
          className: 'ca-btn ca-btn-sm',
          disabled: busy !== '',
          onClick: () => run(`${key}:deny`, { action: 'deny-peer', deviceId: peer.deviceId }, '已拒绝')
        }, '拒绝'))
      }

      if (admitted) {
        actions.push(h('button', {
          key: 'block',
          type: 'button',
          className: 'ca-btn ca-btn-danger ca-btn-sm',
          disabled: busy !== '',
          onClick: () => {
            if (!window.confirm(`封禁「${display}」？\n\n之后它发来的连接、指令和文件都会被拒绝。`)) return
            run(`${key}:block`, { action: 'block', deviceId: peer.deviceId }, '已封禁')
          }
        }, '封禁'))
      }

      if (peer.state === 'rejected' || peer.state === 'blocked') {
        actions.push(h('button', {
          key: 'remove',
          type: 'button',
          className: 'ca-btn ca-btn-sm',
          disabled: busy !== '',
          onClick: () => {
            const aliasNote = alias === '' ? '' : '\n\n这个别名也会一起清掉。'
            if (!window.confirm(`移除「${display}」的记录？${aliasNote}\n\n移除后，它下次请求连接时会重新出现在这里。`)) return
            run(`${key}:remove`, { action: 'remove', deviceId: peer.deviceId }, '已移除记录')
          }
        }, '移除记录'))
      }

      const stateText = {
        admitted: peer.online ? '在线' : '离线',
        pending: hasLiveHello ? '等你放行' : '还没放行',
        discovered: '在局域网里发现了它',
        rejected: '你拒绝过它',
        blocked: '已封禁'
      }[peer.state] ?? peer.state

      const lastSeen = peer.online || !peer.lastSeenAt ? '' : `上次看到它 ${dateOnly(peer.lastSeenAt)} ${clockTime(peer.lastSeenAt)}`
      const admittedText = peer.admittedAt ? `已放行 ${relative(peer.admittedAt, now)}` : ''

      return h('div', { className: 'ca-peer' },
        h('div', { className: 'ca-peer-top' },
          h('span', { className: `ca-dot ${peer.online ? 'ca-dot-on' : peer.state === 'pending' ? 'ca-dot-warn' : 'ca-dot-off'}` }),
          h('span', { className: 'ca-peer-name', title: peer.deviceId }, display),
          alias !== '' && alias !== peer.name && peer.name !== '未命名'
            ? h('span', { className: 'ca-peer-original', title: '对端自己的显示名' }, `· ${peer.name}`)
            : null,
          h('button', {
            type: 'button',
            className: 'ca-icon-btn ca-edit-btn',
            ref: editButton,
            title: alias === '' ? '给对端起个别名' : '改别名',
            'aria-label': alias === '' ? '给对端起个别名' : '改对端别名',
            'aria-expanded': editingAlias,
            onClick: () => {
              if (editingAlias) closeAlias()
              else beginAlias()
            }
          }, h(EditIcon)),
          h('span', { className: `ca-peer-state${peer.online && admitted ? ' ca-peer-state-on' : ''}` }, stateText),
          h('div', { className: 'ca-peer-actions' }, actions)
        ),
        editingAlias
          ? h('div', { className: 'ca-alias-row' },
            h('input', {
              className: 'ca-alias-input',
              ref: aliasInput,
              value: aliasDraft,
              placeholder: peer.name || '别名',
              maxLength: 32,
              'aria-label': '对端别名',
              onChange: (event) => setAliasDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  closeAlias()
                  return
                }
                // 中文输入法选词时的回车不是"保存"
                const composing = event.nativeEvent?.isComposing === true || event.keyCode === 229
                if (event.key === 'Enter' && !composing) saveAlias(aliasDraft)
              }
            }),
            h('button', {
              type: 'button',
              className: 'ca-btn ca-btn-primary ca-btn-sm',
              disabled: busy !== '',
              onClick: () => saveAlias(aliasDraft)
            }, busy === aliasKey ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              className: 'ca-btn ca-btn-sm',
              disabled: busy !== '',
              onClick: closeAlias
            }, '取消'),
            alias !== ''
              ? h('button', {
                type: 'button',
                className: 'ca-btn ca-btn-ghost ca-btn-sm',
                disabled: busy !== '',
                onClick: () => saveAlias('')
              }, '清除别名')
              : null,
            h('span', { className: 'ca-alias-hint' }, '只在本机显示，工具调用也可以用这个别名；DSH 里已有的「跨端 · 显示名」会话标题不变。')
          )
          : null,
        h('div', { className: 'ca-peer-meta' },
          admitted && admittedText !== '' ? h('span', null, admittedText) : null,
          admitted && admittedText !== '' && peer.fingerprint ? h('span', { className: 'ca-sep' }, '·') : null,
          peer.fingerprint ? h('span', null, '指纹 ', h('span', { className: 'ca-mono' }, peer.fingerprint)) : null,
          lastSeen !== '' ? h('span', null, lastSeen) : null,
          peer.state === 'pending' && hasLiveHello ? h('span', null, '在上面「等你处理」里等你决定') : null
        ),
        admitted
          ? h('div', { className: 'ca-peer-body' },
            h('div', { className: 'ca-mode', role: 'group', 'aria-label': '权限模式' },
              h('button', {
                type: 'button',
                className: 'ca-mode-btn',
                'aria-pressed': mode === 'confirm',
                disabled: busy !== '',
                onClick: () => {
                  if (mode === 'confirm') return
                  run(`${key}:mode`, { action: 'mode', deviceId: peer.deviceId, mode: 'confirm' }, '已改回需要审核')
                }
              }, '需要审核'),
              h('button', {
                type: 'button',
                className: 'ca-mode-btn ca-mode-open',
                'aria-pressed': mode === 'open',
                disabled: busy !== '',
                onClick: () => {
                  if (mode === 'open') return
                  if (!window.confirm(`把「${display}」改成完全开放？\n\n之后它发来的指令消息和文件会直接生效，不再问你。`)) return
                  run(`${key}:mode`, { action: 'mode', deviceId: peer.deviceId, mode: 'open', confirmed: true }, '已改成完全开放')
                }
              }, '完全开放')
            ),
            h('p', { className: `ca-mode-note${mode === 'open' ? ' ca-mode-note-warn' : ''}` },
              mode === 'open'
                ? '对端发来的指令消息和文件会直接生效，不再问你。'
                : '对端发来的每条指令消息和文件，都要你点一次同意。')
          )
          : null
      )
    }

    // ── 一条活动 ──────────────────────────────────────────────────────────

    function Facts ({ event }) {
      const raw = event.raw ?? {}
      const rows = [
        ['时间', fullTime(event.at)],
        event.peerId
          ? ['对端', `${event.peerAlias && event.peerAlias !== event.peerName ? `${event.peerAlias} / ${event.peerName}` : (event.peerName || '未知对端')} · ${shortId(event.peerId)}`]
          : null,
        ['记录', `${raw.kind ?? '?'} / ${raw.outcome ?? '—'}`],
        event.meta ? [event.category === 'file' ? '大小' : '附注', event.meta] : null,
        event.sha256 ? ['sha256', event.sha256] : null
      ].filter(Boolean)
      return h('dl', { className: 'ca-kv' },
        rows.map(([label, value]) => h(React.Fragment, { key: label },
          h('dt', null, label),
          h('dd', null, String(value) === '' ? '—' : value)
        ))
      )
    }

    function EventRow ({ event, multiPeer }) {
      const [open, setOpen] = useState(false)
      const [clipped, setClipped] = useState(false)
      const textRef = useRef(null)
      const chipClass = `ca-ev-chip${event.chipTone === 'bad' ? ' ca-ev-chip-bad' : event.chipTone === 'warn' ? ' ca-ev-chip-warn' : ''}`
      const outClass = `ca-ev-out${event.outTone === 'error' ? ' ca-ev-out-bad' : event.outTone === 'warn' ? ' ca-ev-out-warn' : ''}`
      const full = event.detailFull !== '' ? event.detailFull : event.text
      const multiLine = /\n/.test(full)

      // 只在真的被截断时，展开里才重复一遍全文——否则展开只是补元数据
      useEffect(() => {
        const element = textRef.current
        if (element === null) return undefined
        const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1)
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [event.text, event.showPeer, multiPeer])

      return h('div', { className: 'ca-ev-wrap' },
        h('button', {
          type: 'button',
          className: 'ca-ev',
          'aria-expanded': open,
          title: clipped ? full : undefined,
          onClick: () => setOpen((value) => !value)
        },
        h('span', { className: 'ca-ev-time' }, clockTime(event.at)),
        h('span', { className: chipClass }, event.label),
        h('span', { className: 'ca-ev-text', ref: textRef },
          multiPeer && event.showPeer && (event.peerAlias || event.peerName)
            ? h('span', { className: 'ca-ev-peer', title: event.peerAlias ? event.peerName : undefined }, event.peerAlias || event.peerName)
            : null,
          event.text || '（没有内容）'
        ),
        h('span', { className: outClass }, event.outcome || ''),
        h('span', { className: 'ca-ev-meta' }, event.meta || ''),
        h('span', { className: 'ca-ev-chev' }, h(ChevronDown, { open, size: 12 }))
        ),
        open
          ? h('div', { className: 'ca-ev-more' },
            clipped || multiLine ? h('p', { className: 'ca-ev-full' }, full) : null,
            h(Facts, { event }))
          : null
      )
    }

    // ── 详情 ──────────────────────────────────────────────────────────────

    function CopyButton ({ value, label = '复制', notify }) {
      const [copied, setCopied] = useState(false)
      const timer = useRef(null)
      const onCopy = useCallback(async () => {
        const ok = await copyText(value)
        if (!ok) {
          notify({ tone: 'error', text: '复制失败，可以手动选中' })
          return
        }
        setCopied(true)
        notify({ tone: 'ok', text: '已复制' })
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      }, [value, notify])
      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      return h('button', {
        type: 'button',
        className: 'ca-icon-btn',
        title: label,
        'aria-label': label,
        onClick: onCopy
      }, copied ? h(CheckIcon) : h(CopyIcon))
    }

    function SelfName ({ name, busy, run }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(name || '')
      const [error, setError] = useState('')
      const input = useRef(null)
      const editButton = useRef(null)

      useEffect(() => {
        if (!editing) return
        const element = input.current
        if (element !== null) {
          element.focus()
          element.select()
        }
      }, [editing])

      function begin () {
        setDraft(name || '')
        setError('')
        setEditing(true)
      }

      function close () {
        setEditing(false)
        setTimeout(() => editButton.current?.focus(), 0)
      }

      async function save () {
        const next = String(draft ?? '').trim()
        if (next === '') {
          setError('名字不能为空')
          return
        }
        const done = await run('rename:self', { action: 'rename', name: next }, `本机改名为「${next}」`)
        if (done) {
          close()
          setError('')
        }
      }

      if (!editing) {
        return h('span', { className: 'ca-inline' },
          h('span', null, name || '（还没起名）'),
          h('button', {
            type: 'button',
            className: 'ca-icon-btn ca-edit-btn',
            ref: editButton,
            title: '改本机显示名',
            'aria-label': '改本机显示名',
            onClick: begin
          }, h(EditIcon)))
      }

      return h('span', { className: 'ca-inline-edit' },
        h('input', {
          className: 'ca-alias-input',
          ref: input,
          value: draft,
          maxLength: 32,
          'aria-label': '本机显示名',
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              close()
              return
            }
            // 中文输入法选词时的回车不是"保存"
            const composing = event.nativeEvent?.isComposing === true || event.keyCode === 229
            if (event.key === 'Enter' && !composing) save()
          }
        }),
        h('button', {
          type: 'button',
          className: 'ca-btn ca-btn-primary ca-btn-sm',
          disabled: busy !== '',
          onClick: save
        }, busy === 'rename:self' ? '保存中…' : '保存'),
        h('button', {
          type: 'button',
          className: 'ca-btn ca-btn-sm',
          disabled: busy !== '',
          onClick: close
        }, '取消'),
        error !== '' ? h('span', { className: 'ca-inline-error' }, error) : null,
        h('span', { className: 'ca-inline-hint' }, '对端下次握手时会看到')
      )
    }

    function Details ({ id, self, ports, paths, exposed, startedAt, notify, busy, run }) {
      const shares = paths.shares ?? (paths.share ? [paths.share] : [])
      return h('div', { className: 'ca-details', id },
        h('dl', { className: 'ca-facts' },
          h('dt', null, '本机名'), h('dd', null, h(SelfName, { name: self.name, busy, run })),
          h('dt', null, '设备 ID'),
          h('dd', null, h('span', { className: 'ca-mono' }, self.deviceId ?? ''), h(CopyButton, { value: self.deviceId ?? '', notify, label: '复制设备 ID' })),
          h('dt', null, '收件箱'), h('dd', null, h('span', { className: 'ca-mono' }, paths.inbox ?? '—'), paths.inbox ? h(CopyButton, { value: paths.inbox, notify, label: '复制收件箱路径' }) : null),
          h('dt', null, '共享目录'),
          h('dd', null, shares.length === 0
            ? '—'
            : shares.map((share) => h('span', { key: share, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { className: 'ca-mono' }, share),
              h(CopyButton, { value: share, notify, label: '复制共享目录' })))),
          h('dt', null, '端口'),
          h('dd', null, h('span', { className: 'ca-mono' }, `发现 ${ports.discovery ?? '—'}/udp · 传输 ${ports.rpc ?? '—'}/tcp`)),
          h('dt', null, '开放工具'),
          h('dd', null, exposed.length === 0
            ? '一个都没开放（对端不能调用本机工具）'
            : h('span', { className: 'ca-tools' }, exposed.map((name) => h('span', { key: name, className: 'ca-tool' }, name)))),
          h('dt', null, '启动于'), h('dd', null, startedAt ? fullTime(startedAt) : '—')
        )
      )
    }

    // ── 状态条 ────────────────────────────────────────────────────────────

    function StatusBar () {
      const { data, error } = useRemote()
      const pending = (data?.pending ?? []).filter((item) => item.status !== 'expired' && (item.expiresAt == null || item.expiresAt > Date.now())).length
      const admitted = (data?.peers ?? []).filter((peer) => peer.state === 'admitted')
      const online = admitted.filter((peer) => peer.online).length

      let label = '跨端 · 连接中…'
      let tone = 'idle'
      if (error !== '' && data === null) {
        label = '跨端 · 读不到状态'
        tone = 'bad'
      } else if (data !== null && pending > 0) {
        label = `跨端 · ${pending} 件待审核`
        tone = 'warn'
      } else if (data !== null && admitted.length === 0) {
        label = '跨端 · 没有连接'
        tone = 'idle'
      } else if (data !== null && online === 0) {
        label = `跨端 · ${admitted.length} 个连接（离线）`
        tone = 'idle'
      } else if (data !== null) {
        label = `跨端 · ${online} 在线 · 无待办`
        tone = 'ok'
      }

      return h('button', {
        type: 'button',
        className: `ca-bar${tone === 'warn' ? ' ca-bar-warn' : tone === 'bad' ? ' ca-bar-bad' : ''}`,
        title: '打开跨端面板',
        onClick: () => {
          try {
            runtime?.layout?.selectPanel?.(PANEL_ID)
          } catch {
            // 没有 layout 就只是不跳转
          }
        }
      },
      h('span', { className: `ca-dot ${tone === 'ok' ? 'ca-dot-on' : tone === 'warn' ? 'ca-dot-warn' : 'ca-dot-off'}` }),
      h('span', { 'aria-live': 'polite' }, label))
    }

    function apply (ctx) {
      runtime = ctx
      ensureStyle()
      const disposers = []
      /**
       * 槽位必须先被拥有者声明（`main`/`shell.bottom` 由 ui-layout 声明，
       * `sidebar.panellist` 由 ui-sidebar 声明）。`inject` 会在声明已存在时立即
       * 执行回调，否则挂起等声明提交——裸 `register` 在声明尚未出现时会被拒。
       */
      const contribute = (ownerKey, options, Component) => {
        try {
          disposers.push(ctx.slots.inject(ownerKey, () => ctx.slots.register(options, Component)))
        } catch (error) {
          console.warn('[dsh-cross-agent] 槽位注册失败', ownerKey, error)
        }
      }
      try {
        contribute('main', { name: 'main', id: 'cross-agent-panel', key: 'cross-agent', order: 60 }, Panel)
        contribute('shell.bottom', { name: 'shell.bottom', id: 'cross-agent-status', order: 20 }, StatusBar)
        contribute('sidebar.panellist', { name: 'sidebar.panellist', id: 'cross-agent', order: 40, label: () => '跨端 agent' }, CrossAgentIcon)
      } catch (error) {
        console.warn('[dsh-cross-agent] 初始化失败', error)
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // ignore
          }
        }
      }
    }

    return { inject: ['slots'], apply }
  }
})
