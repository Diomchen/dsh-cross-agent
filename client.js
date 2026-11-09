/**
 * Web UI 半侧：一个主面板（`main` 槽位）+ 一条常驻状态条（`shell.bottom`）。
 *
 * 只做三件事：显示状态、把人点的那一下转成 `/cross-agent/action`、把"有 N 条待确认"
 * 一直摆在人眼前。所有判断都在宿主侧（`service.act`），这里不复制任何业务逻辑。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cross-agent',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const POLL_MS = 3000
    const PANEL_ID = 'cross-agent'
    /** 侧栏与状态条都要能打开面板；`ctx.layout` 只有在这里拿得到。 */
    let runtime = null

    async function call (body) {
      const response = await fetch('/cross-agent/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || json?.ok === false) {
        throw new Error(json?.reason ?? `HTTP ${response.status}`)
      }
      return json
    }

    function useCrossAgent () {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')

      const refresh = useCallback(async () => {
        try {
          const response = await fetch('/cross-agent/state', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const json = await response.json()
          setState(json.state)
          setError('')
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const run = useCallback(async (body) => {
        setBusy(body.action)
        try {
          const json = await call(body)
          if (json?.state) setState(json.state)
          else await refresh()
          setError('')
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setBusy('')
        }
      }, [refresh])

      return { state, error, busy, run, refresh }
    }

    const S = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '18px 20px',
        height: '100%',
        overflow: 'auto',
        font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
      },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      muted: { opacity: 0.62, fontSize: 12 },
      section: {
        border: '1px solid rgba(127,127,127,0.24)',
        borderRadius: 10,
        padding: '10px 12px',
        background: 'rgba(127,127,127,0.05)'
      },
      sectionTitle: { fontWeight: 600, fontSize: 12, opacity: 0.7, marginBottom: 8, letterSpacing: '0.02em' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        borderTop: '1px solid rgba(127,127,127,0.14)'
      },
      rowFirst: { borderTop: 'none' },
      dot: (online) => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        background: online ? '#19b36b' : 'rgba(127,127,127,0.45)',
        flex: '0 0 auto'
      }),
      name: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 },
      badge: (tone) => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid rgba(127,127,127,0.3)',
        background: tone === 'warn' ? 'rgba(230,150,20,0.16)' : tone === 'open' ? 'rgba(220,60,60,0.14)' : 'rgba(127,127,127,0.1)',
        whiteSpace: 'nowrap'
      }),
      button: (primary) => ({
        font: 'inherit',
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 7,
        cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.35)',
        background: primary ? 'rgba(43,120,255,0.16)' : 'transparent',
        color: 'inherit'
      }),
      spacer: { flex: 1 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.7 },
      empty: { opacity: 0.55, padding: '4px 0' },
      error: { color: '#d9534f', fontSize: 12 },
      statusBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 12px',
        font: '12px/1.6 ui-sans-serif, system-ui, sans-serif',
        cursor: 'pointer',
        opacity: 0.85
      }
    }

    function Panel () {
      const { state, error, busy, run } = useCrossAgent()

      if (state === null) {
        return h('div', { style: S.panel }, h('div', { style: S.empty }, error === '' ? '正在读取跨端状态…' : `读不到状态：${error}`))
      }

      return h('div', { style: S.panel },
        h('div', { style: S.header },
          h('h2', { style: S.title }, '跨端 agent'),
          h('span', { style: S.muted }, `${state.self.name}`),
          h('span', { style: S.mono }, state.self.deviceId.slice(0, 8)),
          h('span', { style: S.spacer }),
          h('span', { style: S.muted }, `发现 ${state.ports.discovery}/udp · RPC ${state.ports.rpc}/tcp`)
        ),
        error !== '' ? h('div', { style: S.error }, error) : null,

        h(Section, { title: `连接（${state.peers.length}）` },
          state.peers.length === 0
            ? h('div', { style: S.empty }, '局域网上还没看到对端。确认两台机器在同一网段，防火墙放行 UDP 45881。')
            : state.peers.map((peer, index) => h(PeerRow, { key: peer.deviceId, peer, first: index === 0, busy, run }))
        ),

        h(Section, { title: `待审核（${state.pending.length}）` },
          state.pending.length === 0
            ? h('div', { style: S.empty }, '没有等你点头的事。')
            : state.pending.map((item, index) => h(PendingRow, { key: item.id, item, first: index === 0, busy, run }))
        ),

        h(Section, { title: `传输（最近 ${state.transfers.length}）` },
          state.transfers.length === 0
            ? h('div', { style: S.empty }, '还没有文件往来。')
            : state.transfers.slice(0, 12).map((row, index) => h('div', {
              key: `${row.at}-${index}`,
              style: index === 0 ? { ...S.row, ...S.rowFirst } : S.row
            },
            h('span', { style: S.badge(row.direction === 'out' ? 'warn' : undefined) }, row.direction === 'out' ? '发出' : '收到'),
            h('span', { style: S.name }, row.name),
            h('span', { style: S.mono }, `${row.size} B`),
            h('span', { style: S.spacer }),
            h('span', { style: S.muted }, new Date(row.at).toLocaleTimeString())
            ))
        ),

        h(Section, { title: `审计（最近 ${Math.min(state.audit.length, 20)}）` },
          state.audit.length === 0
            ? h('div', { style: S.empty }, '还没有记录。')
            : state.audit.slice(0, 20).map((row, index) => h('div', {
              key: row.seq,
              style: index === 0 ? { ...S.row, ...S.rowFirst } : S.row
            },
            h('span', { style: S.mono }, new Date(row.at).toLocaleTimeString()),
            h('span', { style: S.badge() }, row.kind),
            h('span', { style: S.name }, row.peerName || row.peerId?.slice(0, 8) || '本机'),
            h('span', { style: S.muted }, row.outcome),
            h('span', { style: S.spacer }),
            h('span', { style: S.muted, title: row.detail }, (row.detail ?? '').slice(0, 40))
            ))
        )
      )
    }

    function Section ({ title, children }) {
      return h('div', { style: S.section },
        h('div', { style: S.sectionTitle }, title),
        children
      )
    }

    function PeerRow ({ peer, first, busy, run }) {
      const admitted = peer.state === 'admitted'
      return h('div', { style: first ? { ...S.row, ...S.rowFirst } : S.row },
        h('span', { style: S.dot(peer.online) }),
        h('span', { style: S.name, title: peer.deviceId }, peer.name),
        h('span', { style: S.badge(peer.state === 'pending' ? 'warn' : admitted && peer.mode === 'open' ? 'open' : undefined) },
          admitted ? `已放行 · ${peer.mode}` : peer.state === 'discovered' ? '已发现' : peer.state),
        peer.fingerprint ? h('span', { style: S.mono, title: '指纹：两端应一致' }, peer.fingerprint) : null,
        h('span', { style: S.spacer }),
        peer.state === 'discovered'
          ? h('button', { style: S.button(true), disabled: busy === 'connect', onClick: () => run({ action: 'connect', deviceId: peer.deviceId }) }, '请求连接')
          : null,
        peer.state === 'pending'
          ? h(React.Fragment, null,
            h('button', { style: S.button(true), disabled: busy !== '', onClick: () => run({ action: 'allow-peer', deviceId: peer.deviceId }) }, '放行'),
            h('button', { style: S.button(), disabled: busy !== '', onClick: () => run({ action: 'deny-peer', deviceId: peer.deviceId }) }, '拒绝'))
          : null,
        admitted
          ? h(React.Fragment, null,
            h('button', {
              style: S.button(),
              disabled: busy !== '',
              title: peer.mode === 'open' ? '改回需要审核' : '改成完全开放（对方 agent 将无需询问地指挥本机 agent）',
              onClick: () => {
                if (peer.mode === 'confirm') {
                  const okToGo = typeof window.confirm === 'function'
                    ? window.confirm(`把「${peer.name}」改成完全开放？\n\n之后它发来的指令与文件会直接生效，不再问你。`)
                    : true
                  if (!okToGo) return
                  run({ action: 'mode', deviceId: peer.deviceId, mode: 'open', confirmed: true })
                } else {
                  run({ action: 'mode', deviceId: peer.deviceId, mode: 'confirm' })
                }
              }
            }, peer.mode === 'open' ? '改回审核' : '改开放'),
            h('button', { style: S.button(), disabled: busy !== '', onClick: () => run({ action: 'block', deviceId: peer.deviceId }) }, '封禁'))
          : null
      )
    }

    function PendingRow ({ item, first, busy, run }) {
      const kind = item.kind === 'hello' ? '连接请求' : item.kind === 'ask' ? '指令' : '文件'
      return h('div', { style: first ? { ...S.row, ...S.rowFirst, flexWrap: 'wrap' } : { ...S.row, flexWrap: 'wrap' } },
        h('span', { style: S.badge(item.kind === 'ask' ? 'warn' : undefined) }, kind),
        h('span', { style: S.name }, item.peerName || item.peerId.slice(0, 8)),
        h('span', { style: { ...S.muted, flex: '1 1 240px', minWidth: 160 } }, item.summary),
        h('button', { style: S.button(true), disabled: busy !== '', onClick: () => run({ action: 'approve', id: item.id }) }, '同意'),
        h('button', {
          style: S.button(),
          disabled: busy !== '' || item.kind === 'hello',
          title: '24 小时内，同一对端、同一类动作不再询问',
          onClick: () => run({ action: 'approve', id: item.id, remember: true })
        }, '同意并记住 24h'),
        h('button', { style: S.button(), disabled: busy !== '', onClick: () => run({ action: 'reject', id: item.id }) }, '拒绝'),
        item.kind === 'ask'
          ? h('div', { style: { ...S.muted, flex: '1 0 100%', paddingTop: 2 } },
            `同意后，对方 agent 会在「跨端 · ${item.peerName || '对端'}」会话里开始执行，消耗本机额度。`)
          : null
      )
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

    function StatusBar () {
      const { state } = useCrossAgent()
      const count = state?.pending?.length ?? 0
      const label = state === null ? '跨端 · 连接中…' : count === 0 ? '跨端 · 无待办' : `跨端 · ${count} 待确认`
      return h('div', {
        style: S.statusBar,
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          try {
            runtime?.layout?.selectPanel?.(PANEL_ID)
          } catch {
            // 没有 layout 就只是不跳转
          }
        }
      }, h('span', { style: S.dot(state !== null) }), h('span', null, label))
    }

    function apply (ctx) {
      runtime = ctx
      const disposers = []
      const register = (options, Component) => {
        try {
          disposers.push(ctx.slots.register(options, Component))
        } catch (error) {
          console.warn('[dsh-cross-agent] 槽位注册失败', options.name, error)
        }
      }
      try {
        register({ name: 'main', id: 'cross-agent-panel', key: 'cross-agent', order: 60 }, Panel)
        register({ name: 'shell.bottom', id: 'cross-agent-status', order: 20 }, StatusBar)
        register({ name: 'sidebar.panellist', id: 'cross-agent', order: 40, label: () => '跨端 agent' }, CrossAgentIcon)
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
