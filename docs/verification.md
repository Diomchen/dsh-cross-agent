# 验证记录（v0.1）

时间：2026-11-09 · 机器：macOS（`gendeMac-mini`）· profile：`desktop` · DSH `0.2.2-rc.1`

## 1. 自动化

```
$ node --test test/*.test.js
# tests 35
# pass 35
# fail 0
```

覆盖：beacon 编解码与拒收、HMAC 正反用例、nonce 重放、X25519 派生对称性与指纹、
存储原子写与环形表、限流窗口、审核队列（去重/TTL/记住 24h/晚到的同意）、
连接状态机与放行协商、文件落盘与哈希校验/同名序号/断流清理/共享目录越界、
跨端会话投递与答复抓取/超时/串行化。

```
$ node scripts/e2e.mjs
✓ 两个实例已启动 48bd0fde 37f83d8e
✓ 两个实例互相看见（本机注册表）
✓ 握手请求已到达 B，待放行 1 条
✓ 已放行，两端指纹一致： b6770479
✓ confirm 模式：指令进入待审核，A 得到 awaiting-review
✓ 记住 24h 生效，指令直接送达并拿到答复： B 机答复：再确认一次：1+1 等于几？（共 14 字）
✓ 文件已送达并校验： …/ws-b/.cross-agent/inbox/A 机/report.txt
✓ 共享目录拉取成功： …/ws-b/.cross-agent/inbox/A 机/hello.md
✓ 审计覆盖： transfer、instruction、admit
✓ 对端下线后快速失败，不卡 120 秒
```

这条脚本用的是**真的** UDP/HTTP/HMAC/文件系统，只有 `sessionController` 与事件总线是假的。

## 2. 装进真实 profile

```
plugin_manager install_bundle → application: applied
lsof: DeepSeek … TCP *:45883 (LISTEN) ; UDP *:45881
$DSH_HOME/dsh-cross-agent/identity.json、audit.json 已生成
GET http://127.0.0.1:60974/cross-agent/state → 200，含 self/ports/peers/pending/audit
$DSH_HOME/dsh-cross-agent/instances/<deviceId>.json 已写入
```

真实运行时还确认了两件事（都写进了 `docs/harness-notes.md`）：

- `@deepseek-ai/dsh-tools` 里的 `defineTool` **在运行时能解析**（链接安装也一样），
  所以工具确实走宿主的定义工厂；
- `output.schema` 用的是"值 schema DSL"：必填写在属性上，**没有**顶层 `required` 数组
  （写错会得到 `unsupported JSON schema: schema.required is not supported`）。

## 2.5 v0.2 追加

- `peer_tool` / `peer_tools`：白名单内可调、名单外 `403 tool-not-exposed`（端到端覆盖）；
- `shareRoots` 多根白名单：落在某个根里才可读，`..` 越界一律 404（单测覆盖）；
- 单测 41 个全绿。

## 3. 没验证到的（诚实清单）

| 项 | 为什么 | 影响 |
|---|---|---|
| 面板与状态条的渲染 | `Slots.listSubTree` 在这个 Host 上超时（没有可用的 Client inspect 通道） | UI 代码按槽位契约写，未经肉眼确认 |
| 两台**物理**机器互连 | 只有一台机器；用双实例 + 本机注册表替代 | UDP 广播、防火墙放行未经真机验证 |
| `peer_ask` 打真实 DSH 会话 | 端到端里的 `sessionController` 是假的 | `src/session.js` 的字段名仍是"按契约写"，见 harness-notes 的待验表 |
| `peer_tool` 打真实工具 | 端到端里的 `ctx.tools.execute` 是假的 | 只按 `results[0]` 的 `isError` / `content` / `value` 宽松读取 |
| macOS/Windows 防火墙弹窗 | 需要人在界面上点 | 已在 README 排错表里写明 |

## 4. 一个已知的安装期坑

插件被停用/再启用时，宿主不会回收上一版挂在 `webServer` 上的路由，
第二次注册会抛 `duplicate prefix route "/cross-agent"`。
v0.1 的处理：路由改成读"模块级当前服务"槽位（残留路由也能服务最新状态），
并把重复注册降级为一条警告。**这一次**由于开发期连续重装，进程里还留着第一版路由，
需要重启一次 DSH 才会完全干净——重启之后不再出现。

（`rpcServer.stop()` 也补了 `closeAllConnections()`，避免卸载卡在等连接上。）
