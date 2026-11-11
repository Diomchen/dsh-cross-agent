import assert from 'node:assert/strict'
import test from 'node:test'

import { splitCommandArgs } from '../src/commands.js'

test('命令分词：普通空格分隔', () => {
  assert.deepEqual(splitCommandArgs('mode DESKTOP open --yes'), ['mode', 'DESKTOP', 'open', '--yes'])
  assert.deepEqual(splitCommandArgs('  status   '), ['status'])
  assert.deepEqual(splitCommandArgs(''), [])
})

test('命令分词：引号里的空格算一个参数（别名可以有空格）', () => {
  assert.deepEqual(splitCommandArgs('mode "家里的 Windows" open --yes'), ['mode', '家里的 Windows', 'open', '--yes'])
  assert.deepEqual(splitCommandArgs("alias 'Mac 测试机' 新别名"), ['alias', 'Mac 测试机', '新别名'])
  assert.deepEqual(splitCommandArgs('alias p ""'), ['alias', 'p', ''], '空引号是"清空别名"而不是被丢掉')
})

test('命令分词：反斜杠可以转义引号与空格', () => {
  assert.deepEqual(splitCommandArgs('say "a \\"b\\" c"'), ['say', 'a "b" c'])
  assert.deepEqual(splitCommandArgs('say a\\ b'), ['say', 'a b'])
})
