#!/usr/bin/env node
/**
 * 校验 npm 包内容（CI 的打包 job 与本地发版前的自检都跑它）：
 *
 *   node scripts/verify-pack.mjs                 # 只看文件清单
 *   node scripts/verify-pack.mjs --version v0.2.7  # 顺带核对 tag 与 package.json 版本
 *
 * 规则只有两条：宿主跑起来需要的文件一个都不能少；测试、脚本、CI 配置一个都不能混进去。
 * 用的是 `npm pack --dry-run`，也就是真正打包时会走的同一套 files 规则。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'

/** 打包后必须存在的文件。少一个，装到 DSH 里就是起不来或者面板空白。 */
const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'src/service.js',
  'src/protocol.js',
  'src/session.js',
  'src/tools.js',
  'src/http-local.js',
  'src/rpc.js',
  'README.md'
]

/** 这些东西只属于仓库，不该进用户机器的 node_modules。 */
const FORBIDDEN = [
  [/^test\//, '单测'],
  [/^scripts\//, '仓库脚本'],
  [/^\.github\//, 'CI 配置'],
  [/^\.scratch\//, '需求与票据'],
  [/^docs\//, '文档（README/CONTEXT/WINDOWS 已单独列出）'],
  [/^node_modules\//, '依赖'],
  [/\.tgz$/, '历史产物']
]

const args = process.argv.slice(2)
const versionFlag = args.indexOf('--version')
const expectedVersion = versionFlag === -1 ? undefined : args[versionFlag + 1]

const problems = []
const say = (line = '') => process.stdout.write(`${line}\n`)

function packInfo () {
  const raw = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024
  })
  const start = raw.indexOf('[')
  if (start === -1) throw new Error(`npm pack --json 没有输出 JSON：\n${raw}`)
  const [info] = JSON.parse(raw.slice(start))
  return info
}

function main () {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  if (pkg.name !== 'dsh-cross-agent') problems.push(`包名不对：${pkg.name}`)
  if (typeof pkg.version !== 'string' || pkg.version === '') problems.push('package.json 没有 version')

  if (expectedVersion !== undefined) {
    const want = expectedVersion.replace(/^v/, '')
    if (want !== pkg.version) problems.push(`tag ${expectedVersion} 与 package.json 版本 ${pkg.version} 不一致`)
  }

  const info = packInfo()
  const files = new Set(info.files.map((file) => file.path))

  for (const file of REQUIRED) {
    if (!files.has(file)) problems.push(`缺少 ${file}（检查 package.json 的 files 是否覆盖到它）`)
  }
  for (const file of files) {
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(file)) problems.push(`不该打包 ${file}（${what}）`)
    }
  }
  if (files.size !== info.entryCount) problems.push(`文件清单与 entryCount 不一致：${files.size} vs ${info.entryCount}`)

  say(`包：${pkg.name}@${pkg.version}`)
  say(`文件：${info.entryCount} 个，压缩后 ${(info.size / 1024).toFixed(1)} KiB，解压后 ${(info.unpackedSize / 1024).toFixed(1)} KiB`)

  if (problems.length > 0) {
    say('')
    for (const problem of problems) say(`✗ ${problem}`)
    say('')
    say(`打包内容不合格（${problems.length} 处）。`)
    process.exit(1)
  }

  say(`✓ ${REQUIRED.length} 个必需文件齐全，无仓库残留`)
}

try {
  main()
} catch (error) {
  say(`✗ 校验失败：${error?.message ?? error}`)
  process.exit(1)
}
