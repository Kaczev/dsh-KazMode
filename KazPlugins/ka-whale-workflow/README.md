# ka-whale-workflow

鲸鱼工作流组件（v0.9，31 世 + 32 世 B3/B3.5 范围）。

## 范围

- 主/子阶段机：英文 stage id，Allowed tools / Can advance to / Task 与 v0.9
  表格一致。
- `tools/pre-execute` 软闸门：主模型在当前 v0.9 stage 调用非 Allowed tools 返回
  `workflow-stage-deny`，不视为模型失败惩罚。
- 阶段注入：进入 v0.9 stage 时追加 `[ka-whale-workflow <stage-id>]` 上下文，携带
  Allowed / Can advance / Task，并在 write-plan/working/maintenance 阶段携带
  `taskPlanPath`，在 create/update/retire-plugin 阶段携带 `lifecyclePath`，
  在 decide-tools 阶段携带当前私有插件候选目录。
- B2.5 重启语义：Minimal 只在整段 session 第一次 tool/call 前发生；后续
  workflow-run 重新进入 `assess-complexity` 但不重复 Minimal；Goal 存在时不重复
  assess；`assess-complexity -> communication (no-tool-call)` 是合法路径。
- Task plan：独立 `ka-whale-workflow-task-plan.json`；
  `decide-tools` 通过 `whale_report(draftPlanItems)` 第一次持久化（draft）；
  `write-plan` 通过 `whale_report(finalPlanPayload)` 第二次定稿（finalized）；
  `ka_sub_whale` 只接受 finalized planItemId。
- B3 受控委派：`ka_sub_whale` 按 finalized `planItemId` 读取
  persona/task/assignedTools，校验 assignedTools 来源
  （tool-jobs + available 私有插件候选）与数量（>6 提醒、>8 拒绝），
  计算 role Stable Base + assignedTools 最终 toolFilter，再通过
  `ctx.subagents.startContinuable({ provider: 'spawn', maxDepth: 1 })` 创建
  continuable child；模型只能传 `planItemId`。
- B3.5：`[ka-whale-memory Review]` / `[skill Review]` 复盘边界已移除，正常/Goal
  结束不再注入两类标题。
- 新工具注册：`ka_sub_whale` 实际受控委派层 + 四个 `*_sub_whale_report`
  （包装 DSH reportFrom，continuable child 内真实可调用）；
  `list_agents / send_message / interrupt_agent` 由 DSH subagent-control 提供，
  ka-whale-workflow/kaz-shared 负责 Stable Main Surface 放行。
- `KAZ_TASK_PLAN_STORE_PATH` / `KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH` /
  `KAZ_PRIVATE_PLUGIN_CANDIDATE_PATH` 由 `kaz-shared` 定义；
  `PLUGIN_LIFECYCLE.md` 放本组件目录并受 Git 跟踪。

## 未做（留给后续世代）

- B4 面板只读化、B5 旧代码清理、B6 KAZ_ROLE_PROMPTS/round-display/paths/热重载。
- 不删除旧 `subagent` / `create_goal` / 旧角色常量（B5 处理）。

## 设置

- `enabled`：总开关。
- `includeSubagents`：子代理是否也走鲸鱼工作流，默认关。
- 旧 `reconstructionTools` / `taskToolSelectionEnabled` / `enable_tool` 相关设置
  保留为兼容读取，不再参与 v0.9 主模型 stage 面。

## 存储

- 阶段状态：`~/.dsh/storages/ka-whale-workflow-stage.json`（version 5，
  含 sessions / taskToolState / contractState / workflowRuns /
  pendingStageInjection / subagentRoles）。
- Task plan：`~/.dsh/storages/ka-whale-workflow-task-plan.json`。
- 生命周期参考：`KazPlugins/ka-whale-workflow/PLUGIN_LIFECYCLE.md`。
- 私有插件候选注册表：`~/.dsh/storages/kaz-agent-managed-tools.json`
  （schema version 2；顶层 `candidates`）。
