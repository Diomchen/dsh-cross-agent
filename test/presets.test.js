import assert from 'node:assert/strict'
import test from 'node:test'

import { matchRule, normalizeRules, resolveSessionPreset } from '../src/presets.js'

test('规则表：丢掉形状不对的，按路径长度倒序（更具体的先命中）', () => {
  const rules = normalizeRules([
    { path: '/work', preset: 'workspace-write' },
    { path: '/work/secret/', preset: 'read-only' },
    { path: '', preset: 'read-only' },
    { path: '/x', preset: '不存在' },
    null,
    'nope'
  ])
  assert.deepEqual(rules.map((r) => r.path), ['/work/secret', '/work'])
})

test('最长前缀匹配，且按路径分隔符算，不会把 /worker 当成 /work 的子目录', () => {
  const rules = normalizeRules([
    { path: '/work', preset: 'workspace-write' },
    { path: '/work/secret', preset: 'read-only' }
  ])
  assert.equal(matchRule(rules, '/work/a/b')?.path, '/work')
  assert.equal(matchRule(rules, '/work/secret')?.path, '/work/secret')
  assert.equal(matchRule(rules, '/work/secret/x')?.path, '/work/secret')
  assert.equal(matchRule(rules, '/worker/a'), null)
})

test('没命中规则时用默认档', () => {
  const result = resolveSessionPreset({ dir: '/tmp/whatever', rules: [], fallback: 'read-only' })
  assert.equal(result.preset, 'read-only')
  assert.equal(result.source, 'default')
})

test('命中规则时以规则为上限', () => {
  const rules = normalizeRules([{ path: '/work/secret', preset: 'read-only' }])
  const result = resolveSessionPreset({ dir: '/work/secret/a', rules })
  assert.equal(result.preset, 'read-only')
  assert.equal(result.source, 'rule')
})

test('远端可以往紧里调', () => {
  const rules = normalizeRules([{ path: '/work', preset: 'danger-full-access' }])
  const result = resolveSessionPreset({ dir: '/work/x', requested: 'read-only', rules })
  assert.equal(result.preset, 'read-only')
  assert.equal(result.clamped, false)
})

test('远端不能自己往松里调：夹到本地上限，并标出被夹过', () => {
  const rules = normalizeRules([{ path: '/work', preset: 'workspace-write' }])
  const result = resolveSessionPreset({ dir: '/work/x', requested: 'danger-full-access', rules })
  assert.equal(result.preset, 'workspace-write')
  assert.equal(result.requested, 'danger-full-access')
  assert.equal(result.clamped, true)
})

test('显式允许时，远端可以提权（allowRemotePermissionRaise）', () => {
  const rules = normalizeRules([{ path: '/work', preset: 'workspace-write' }])
  const result = resolveSessionPreset({ dir: '/work/x', requested: 'danger-full-access', rules, allowRaise: true })
  assert.equal(result.preset, 'danger-full-access')
  assert.equal(result.clamped, false)
})

test('远端传了个不认识的档：当成没提要求', () => {
  const rules = normalizeRules([{ path: '/work', preset: 'workspace-write' }])
  const result = resolveSessionPreset({ dir: '/work/x', requested: 'yolo', rules })
  assert.equal(result.preset, 'workspace-write')
  assert.equal(result.requested, null)
})
