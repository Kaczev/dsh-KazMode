# kaz-context-runtime（Kaz7.0 M6 运行时接线 driver）

KazPlugins 正式 Cordis 插件：只挂 Kaz preset；v0.2.0 起注册只读
`whale_expand` 工具（M6 Stable Main 版本边界 19→20；现已升级为 Kaz 主/子代理常驻
Base 并移出私有插件候选）；v0.3.0 起在结构里程碑用
DSH 官方 `surfaceOp replace` 把旧历史段替换成 `render()` 最新分支剖面 checkpoint；
v0.3.1 起提供 `kazContextBoundary` workflow 边界桥，把 planItem(level 2) / goal
(level 3) 的 open/close 接到同一条 surface-replace 管线。不改 DSH 核心。

## 作用

- 监听真实 DSH `session/event`，把 append-origin 的 `user/message`、
  `assistant/message`、`tool/result` 归一化为 Kaz 树叶子
  `user / assistant / tool / injection / subagent_report`；
- 通过 `kaz-shared` 的 `session-tree-store-io` 按 DSH session 持久化树；
- 在可靠结构边界（`agent/turn-stopping`，并以 `turn/end completed` 兜底）
  用 `whaleSummarizer` 为直接 children 生成摘要后 `close`；
- summary 失败只把边界置为 pending，不污染已完成回合，下一 `agent/pre-step`
  重试；
- 来源过滤（只镜像 append surface + 跳过 Kaz 自有/replacement 事件）、
  per-session single-flight、边界-only replace 纪律。

## v0.3.1：workflow 边界桥（kazContextBoundary）

- `ctx.provide("kazContextBoundary")` 提供内部服务：
  - `openPlanItem / closePlanItem`（level 2）、`openGoal / closeGoal`
    （level 3）；
  - 通用 `open/close/status/handleBoundaryEvent`；
  - close 走与 round close 相同的 single-flight
    `whaleSummarizer → close → commit → surface-replace checkpoint`；
    目标边界之下仍有 open scope 时先按 LIFO 关闭（不产生中间 checkpoint），
    再关目标边界并只发一次 surface-replace。
- 兼容显式 Kaz 边界事件：`session/event` 上
  `kazContextBoundary/open` / `kazContextBoundary/close` 会被转发给服务，
  且不会作为树叶子镜像。
- Best-effort workflow 信号桥（不读/不改公共插件文件）：
  - 受控 v0.9 子代理有 `kaWhaleWorkflow.subagentRoleOf` 角色记录且 stage 未到
    `end/done` → 自动 open planItem；stage 到 `end/done` → 自动 close
    planItem；
  - `goals` 服务 phase active/paused → 自动 open goal；phase 离开
    active/paused（如 complete）→ 自动 close goal。
- 缺失上游事件的待接清单（不跳过实现，现阶段以显式 API 为准）：
  1. planItem done 主会话语义；
  2. goal close 终态事件；
  3. subagent report ↔ planItemId 关联。
  这些语义补齐前，主会话/主流程边界由调用方经 `kazContextBoundary` 显式
  open/close。

## v0.3.0：持久 surface replacement / compaction

- 结构里程碑 = close 的 `changes` 含 `planItem` / `goal` 关闭，或自动升华
  （`sublime`；4 个 round block 达到可压缩边界）。v0.3.1 后 planItem/goal
  close 已可由边界桥/服务真实到达，不再只是纯层测试。
- 里程碑且子块摘要已落定后，driver 在同一个 single-flight close 段内追加**一条**
  Kaz-owned `user/message` checkpoint：
  - `surfaceOp: { op: "replace", start, end }`（官方公共 seam）；
  - `sourceEventSeqs` = 当前 surface 前缀全部被遮蔽节点；
  - `content` = `render(session, {mode:"text"})` 最新分支剖面输出；
  - `source` = `{ kind:"plugin", plugin:"kaz-context-runtime", ... }`，
    因此 driver 不会把自己的 checkpoint 再镜像进树。
- 只允许 contiguous surface 前缀替换：不跳过更早 live 节点、不 shadow 当前
  未闭合 raw。
- 替换失败被包含：`Session.append` 原子失败 → 原历史/surface 不变，树 close
  仍已提交，已完成用户回合不报错，下一里程碑重试。
- 与 DSH 压缩协调：Kaz preset 中 `compaction-basic` 设 `auto:false`；foreign
  `compaction/start…end` 期间 driver 不做 Kaz replace。

## whale_expand（v0.2.0 · M6 版本边界）

- 工具名：`whale_expand`（只读）。
- 包装：`kaz-shared/lib/session-tree-expand.js` 的纯 `expand()`，始终使用
  当前 session 的完整持久化 Session（hiddenRootIds/checkpoint 不影响展开）。
- 入参：`path`（必填；`""` 列出根 children）、可选 `limit`、可选 `cursor`。
- 注册范围：Kaz preset 内 `ctx.tools.register`；同时常驻主面与全部子代理 Stable
  Base：`KAZ_V09_MAIN_TOOLS` / `KAZ_STABLE_MAIN_TOOLS`（Stable Main 20 项）、
  `KAZ_SUBAGENT_BASE_TOOLS`（保守 Base 12 项）、`KAZ_V09_SUBAGENT_ROLE_TOOLS`
  四角色（worker 13 / memoryMaintainer 11 / pluginMaintainer 9 /
  pluginCreator 9，均含该工具）。
- 候选注册：已从 `~/.dsh/storages/kaz-agent-managed-tools.json` 的
  `candidates` 移除（常驻 Stable Base 后不再依赖该候选做 `assignedTools`；
  `safe_json_write` 等其余候选保留）。
- 只读纪律：执行只做 `store` 加载 + 纯 `expand`，不调用 DSH
  `session.append`，不写树、不写 store、不读 archive。

## 装载

- `~/.dsh/.agent-presets/kaz/agent.cordis.yml` 已挂
  `kaz-context-runtime` 行（Kaz preset only）；
- 同文件 `compaction-basic` 行已设 `auto:false`（Kaz 树边界 replace 负责 Kaz
  压缩；`/compact` 手动路径仍可用）；
- `~/.dsh/profiles/web/package.json` 已含
  `"kaz-context-runtime": "file:KazPlugins/kaz-context-runtime"`；
- 不挂 profile 全局 `cordis.patch.yml`。
- v0.3.1 没有新增模型可见工具、没有改 Stable Main/candidate registry。

## 运行期注意

- 生效按 v0.9 生命周期：无 hot reload，下次 task 或 DSH 重启后生效；
- 每个 DSH session 一个 store：`~/.dsh/storages/kaz-context/sessions/…`；
  DSH raw session log 仍是权威，删除树 store 只影响树索引/checkpoint 文本；
  checkpoint replace 后 raw log 原文仍可由 `whale_expand` 读回。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-context-runtime\probe-core.mjs"
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-context-runtime\probe-runtime.mjs"
```

全部离线：合成 DSH 事件、stub whaleSummarizer、临时 store rootDir、录制式
session surface append（只接受 Kaz-owned replace，其它 append 仍报错）。
v0.3.1 probe-runtime 覆盖：
- planItem 完成 → level2 close → surface-replace；
- Goal 完成 → level3 close → surface-replace；
- 显式 `kazContextBoundary` 服务与兼容事件路径；
- ka-whale-workflow 受控角色/goals 信号的自动 open/close 桥。
