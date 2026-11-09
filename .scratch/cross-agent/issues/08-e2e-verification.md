# 08 · 两实例端到端验证

**阻塞**：无（最后一票）
**被阻塞**：01–07

## 目标

用本机两个独立 `DSH_HOME` 跑通 SPEC §10 的全部 8 条验收，并把证据留在仓库里。

## 交付

- `scripts/fake-peer.mjs`：不装 DSH 也能假装一个对端（UDP beacon + HTTP 端点），供单机调试。
- `scripts/e2e.mjs`：起两个 `DSH_HOME`、装插件、走完 放行 → ask → 审 → 文件 → 离线 的路径。
- `docs/verification.md`：逐条验收 + 实际输出片段 + 未验证项（含"真机第二台"是否跑过）。

## 验收

- SPEC §10 八条全绿，或明确标注哪条只能人工做、为什么。
- `npm test` 全绿；`node --check` 全部文件通过。
- 插件在 `desktop` profile 安装后，DSH 重启正常，`/cross-agent/state` 返回 200。

## 不做

CI、发布到 npm（先本地 `install_bundle`）。
