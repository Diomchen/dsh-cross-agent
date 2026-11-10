/**
 * 会话权限档（宿主 `permissionPresets` 的三档）与"按目录的默认值"。
 *
 * 这里的规则只有一条：**远端可以往低调，不能自己往高调**。
 * 新会话的权限上限由接收方自己的配置（`sessionPermissionRules`）决定，
 * 远端在请求里带的 `permission` 只是"我想要更松/更紧"的意愿：
 *   - 比上限低 → 采用（远端可以主动收紧）；
 *   - 比上限高 → 夹到上限，除非接收方显式开了 `allowRemotePermissionRaise`。
 *
 * 纯函数，不碰 IO：规则怎么算可以单测，服务的接线在 service.js。
 */
export const SANDBOX_PRESETS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
export const DEFAULT_SESSION_PRESET = 'workspace-write'

export function isPreset (value) {
  return typeof value === 'string' && SANDBOX_PRESETS.includes(value)
}

export function presetRank (value) {
  return SANDBOX_PRESETS.indexOf(value)
}

/**
 * 归一化配置里的规则表：`[{ path, preset }]`。
 * 路径必须是绝对路径；排序按路径长度倒序，好让"更具体的目录"先命中。
 */
export function normalizeRules (value) {
  if (!Array.isArray(value)) return []
  const rules = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue
    const dir = typeof raw.path === 'string' ? raw.path.trim() : ''
    const preset = typeof raw.preset === 'string' ? raw.preset.trim() : ''
    if (dir === '' || !isPreset(preset)) continue
    rules.push({ path: dir.replace(/[\\/]+$/, ''), preset })
  }
  rules.sort((a, b) => b.path.length - a.path.length)
  return rules
}

/** 最长前缀匹配：`/work/a/b` 命中 `/work/a`，也命中 `/work`，取更长的那个。 */
export function matchRule (rules, dir) {
  if (typeof dir !== 'string' || dir === '') return null
  const target = dir.replace(/[\\/]+$/, '')
  for (const rule of rules) {
    if (target === rule.path) return rule
    const sep = rule.path.endsWith('\\') ? '' : (rule.path.includes('\\') ? '\\' : '/')
    if (target.startsWith(rule.path + sep)) return rule
  }
  return null
}

/**
 * 算出这条新会话实际用哪一档。
 * @returns {{preset: string, requested: string|null, clamped: boolean, source: 'request'|'rule'|'default'}}
 */
export function resolveSessionPreset ({ dir, requested = null, rules = [], fallback = DEFAULT_SESSION_PRESET, allowRaise = false } = {}) {
  const rule = matchRule(rules, dir)
  const base = rule !== null ? rule.preset : (isPreset(fallback) ? fallback : DEFAULT_SESSION_PRESET)
  const want = isPreset(requested) ? requested : null
  if (want === null) return { preset: base, requested: null, clamped: false, source: rule !== null ? 'rule' : 'default' }
  if (presetRank(want) <= presetRank(base) || allowRaise) {
    return { preset: want, requested: want, clamped: false, source: 'request' }
  }
  return { preset: base, requested: want, clamped: true, source: rule !== null ? 'rule' : 'default' }
}
