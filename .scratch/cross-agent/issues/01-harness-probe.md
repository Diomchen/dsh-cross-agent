# 01 · 摸清宿主接口（探针）

**阻塞**：03、04、06、07、08
**被阻塞**：无
**类型**：spike（允许丢弃代码）

## 目标

在**真实运行的 DSH**上验证四件事，产出一份实测结论 + 一个薄适配层 `src/harness.js`：

1. `ctx.sessionController.prompt({...})` 的真实请求字段与返回；能否唤醒冷会话；
2. 拿到"这一 turn 的答复"的最省事路径（`wait()` 的返回形状 vs 订阅 `session/event` 的 `assistant/message`）；
3. `ctx.webServer.register({kind:'prefix', path:'/cross-agent', ...})` 能否挂上、Client 能否同源 `fetch`；
4. `ctx.storageDomain.open(defineDomain({...}))` 在这个 profile 里能否打开、写读是否如文档。

## 做法

- 一个最小插件（或临时加在本插件里的 `probe` 工具/路由），装进 `desktop` profile，用
  `curl http://127.0.0.1:<port>/cross-agent/probe` 触发，把返回值回显。
- 结论写进 `docs/harness-notes.md`：每条给"字段名 / 返回样例 / 失败时的错误文本"。
- 能不用真相机就不用：**先读** `dsh-api-session-controller` 的 `lib/index.js` 与 `lib/types`，再实测。

## 验收

- `harness-notes.md` 里每条都带一条**实际跑过的**输出片段（不是文档抄写）。
- `src/harness.js` 暴露 `deliver(agent, text)` / `collectReply(sessionId, afterMs)` / `registerLocalRoute()` /
  `openStore(fallbackDir)` 四个薄函数，其余模块只依赖它。
- 探针代码不进最终包（`probe` 默认关）。

## 不做

不设计业务、不写工具、不碰发现与传输。
