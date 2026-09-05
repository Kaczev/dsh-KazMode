# ka-whale-workflow

鲸鱼工作流组件（v0.9，31 世 + 32 世 B3/B3.5 + 33 世 Goal-active 补丁 + 35 世 B5 清理 + 36 世 B6 部分收尾 + 36.5 纠正范围 + 36.6 事件驱动等待与 report 路由 + 36.7 challenge-plan 批评纪律 + 36.8 worker 不提前终止 / memory-maintenance gate / stage-persona mapping / task splitting）。

## 范围

- 主/子阶段机：英文 stage id，Allowed tools / Can advance to / Task 与 v0.9
  表格一致；`decide-goal` 可推进 `working` 或外部模式 `goal-active`；
  36.5 新增 `plugin-preflight`：`decide-tools → plugin-preflight → decide-tools`，
  只 pre-finalize/委派 `pluginCreator` plan item。
- Goal-active 外部模式：`whale_report({mode:'goal', objective, max_goal_rounds?})`
  从 decide-goal 或非主 stage（idle/done/end）进入 `goal-active`；该值写入 stage
  state，但不加入 `MAIN_STAGE_IDS`；goal-active 期间普通 `whale_report` 推进返回
  `workflow-stage-deny`。
- §3.1 边界注入：进入 `goal-active` 注入 Goal-active 上下文；Goal 结束后（无
  active/paused goal）从 `goal-active` 自动切到 `working` 并注入
  `working-resumed`，携带实际 `taskPlanPath`。两类注入都作为插件 user message，
  按边界各一次。
- `tools/pre-execute` 软闸门：主模型与受控 v0.9 子代理在当前 stage 调用非
  Allowed tools 返回 `workflow-stage-deny`，不视为模型失败惩罚。
- 受控 v0.9 子代理：`ka_sub_whale` 创建的
  `worker`/`memoryMaintainer`/`pluginMaintainer`/`pluginCreator` 不受
  `includeSubagents=false` 跳过。idle 时自动进入 role 首阶段
  （`worker=assess-complexity`，其余 `=assess-delegation`），按 pending stage
  注入 role 专属 `[ka-whale-workflow <role-stage>]` 文本，并由 `tools/pre-execute`
  按该 role/stage 的 Allowed tools 软闸门约束；plugin 的 create/update/retire
  阶段注入携带实际 `lifecyclePath`。受控角色不再注入旧通用 `SUBAGENT_FLOW_TEXT`
  （role Persona 已由 ka_sub_whale 提供）；旧/未知子代理仍仅在
  `includeSubagents=true` 时使用通用 subagent-flow。
- B6 收口：`KAZ_ROLE_PROMPTS`（v0.9 §9.1–9.5）作为全量 Persona 唯一源存放在
  `kaz-shared`，本组件 `MAIN_FLOW_TEXT` / `SUBAGENT_FLOW_TEXT` 与
  `V09_ROLE_PERSONAS` 都由它派生；36.6 起子代理 report 的 round-display 摘要改由
  父主线 `agent/pre-step` 捕获（`subagent-report` / `subagent-settled` →
  category=`subagent-report`，记在主 agent 名下），child-side 不再直接写
  round-display。
- 阶段注入：进入 v0.9 stage 时追加 `[ka-whale-workflow <stage-id>]` 上下文，携带
  Allowed / Can advance / Task，并在 write-plan/plugin-preflight/working/maintenance
  阶段携带 `taskPlanPath`，在 create/update/retire-plugin 阶段携带
  `lifecyclePath`，在 decide-tools 阶段携带当前私有插件候选目录。
- B2.5 重启语义：Minimal 只在整段 session 第一次 tool/call 前发生；后续
  workflow-run 重新进入 `assess-complexity` 但不重复 Minimal；Goal 存在时不重复
  assess；`assess-complexity -> communication (no-tool-call)` 是合法路径。
- 36.5 用户消息路由：真实用户消息在非终态活动阶段保留当前阶段，不重置成
  `assess-complexity`；只有 `idle`/`done`/`end`/`communication` 才重置。
- 36.5 verification-gap follow-up：`current === 'goal-active'` 但 Goal 已不在
  active/paused（stale goal-active）时，新一轮真实用户消息回到
  `assess-complexity`，不再保留失效的 `goal-active`；Goal 仍激活时仍保持
  `goal-active`。
- 子代理回传不触发新一轮：DSH `subagent-report` / `subagent-settled` 等内部消息
  不是真实用户消息，`isUserMessage` 返回 false，不会把主模型 working 重置成
  `assess-complexity`。
- Task plan：独立 `ka-whale-workflow-task-plan.json`；
  `decide-tools` 通过 `whale_report(draftPlanItems)` 第一次持久化（draft）；
  `plugin-preflight` 通过 `whale_report(finalPlanPayload)` 只 pre-finalize
  `pluginCreator` items（完整 create + 登记候选）；
  `write-plan` 通过 `whale_report(finalPlanPayload)` 第二次完整定稿（finalized）；
  plan item `persona` 允许 `main` + 四子代理角色；`ka_sub_whale` 只接受
  finalized planItemId 且 persona 必须是四子代理角色之一，`persona=main` 返回
  结构化 `main-persona-delegation-denied`。
- B3 受控委派：`ka_sub_whale` 按 finalized `planItemId` 读取
  persona/task/assignedTools，校验 assignedTools 来源
  （tool-jobs + available 私有插件候选）与数量（>6 提醒、>8 拒绝），
  计算 role Stable Base + assignedTools 最终 toolFilter，再通过
  `ctx.subagents.startContinuable({ provider: 'spawn', maxDepth: 1 })` 创建
  continuable child；模型只能传 `planItemId`。
- 36.5 working 委派语义：`persona=main` 由主线执行，子代理 persona 经
  `ka_sub_whale` 委派；主线监控/验证/改约并只在计划外提问；working 后若仍有
  `memoryMaintainer`/`pluginMaintainer`/`pluginCreator` items 或候选建议，必须先
  走 `memory-maintenance`/`plugin-maintenance` 再 communication。
- 36.6 事件驱动等待：`ka_sub_whale` 创建 continuable child 后，主线不使用
  `pwsh sleep` / 轮询 `list_agents` 等待；应结束当前回合，等子代理 report/finished
  消息到达主会话再继续。`list_agents` / `send_message` 不是等待原语；主 Persona、
  working/plugin-preflight/memory-maintenance/plugin-maintenance 注入与
  `ka_sub_whale` description/output 都明确该口径。
- 36.7 challenge-plan 批评纪律：主/worker 的 challenge-plan 阶段要求先批评、
  识别真实弱点、不制造批评；主 Persona/working 要求批判性评估子代理报告与
  批评、不盲从，worker Persona 要求先批评委派、识别真弱点、不盲从。阶段定义与
  `KAZ_ROLE_PROMPTS` 同步更新，避免文档/代码漂移。
- 36.8 worker 不提前终止：worker `challenge-plan` 只可推进到 `check-tools`；
  challenge/check-tools 不是执行阶段，完整 working 文件工具面
  （edit/write/pwsh/read）在 `working` 才授予；worker 不得在到达 working 前报告
  工具不足。`check-tools` 仍保留 `communication`，但只用于 genuine blockers。
- 36.8 mandatory memory-maintenance gate：主 `working` 只可推进到
  `write-plan`（改约）或 `memory-maintenance`；`working → communication` 与
  `working → plugin-maintenance` 已移除，`whale_report` 从 working 的默认推进
  目标是 `memory-maintenance`。working 完成后总是先进入 memory-maintenance，
  再按 plugin work 进入 plugin-maintenance 或 communication。
- 36.8 stage-persona mapping：`ka_sub_whale` 的委派阶段与 persona 固定映射
  （plugin-preflight→pluginCreator、working→worker、
  memory-maintenance→memoryMaintainer、plugin-maintenance→pluginMaintainer）；
  不匹配返回结构化 `stage-persona-mismatch`。
- 36.8 task splitting：write-plan 必须为每个 coherent task 建独立 planItem；
  working 逐个委派 worker planItems；memory/plugin planItems 留给对应维护阶段，
  pluginCreator planItems 留给 plugin-preflight。
- B3.5：`[ka-whale-memory Review]` / `[skill Review]` 复盘边界已移除，正常/Goal
  结束不再注入两类标题。
- 新工具注册：`ka_sub_whale` 实际受控委派层 + 四个 `*_sub_whale_report`
  （每个工具按角色不同流程推进 stage，并包装 DSH reportFrom 把 output 汇报给
  父主模型；`nextStage` 用于推进，省略 `nextStage` 时只原生汇报）；
  `list_agents / send_message / interrupt_agent` 由 DSH subagent-control 提供，
  ka-whale-workflow/kaz-shared 负责 Stable Main Surface 放行。
- `KAZ_TASK_PLAN_STORE_PATH` / `KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH` /
  `KAZ_PRIVATE_PLUGIN_CANDIDATE_PATH` 由 `kaz-shared` 定义；
  `PLUGIN_LIFECYCLE.md` 放本组件目录并受 Git 跟踪。

## 未做（留给后续世代）

- B4 面板只读化由 34 世完成（见 `KazPlugins/kaz-mode/README.md`）。
- B5 旧代码清理由 35 世完成：`enable_tool` / `reconstructionTools` /
  `taskToolSelectionEnabled` / 旧 optional_tools 路径 / 旧 stage 字符串与旧
  `subagent`/`create_goal`/旧角色常量已退役。
- B6（36 世已完成本世代子集）：KAZ_ROLE_PROMPTS 全量终稿入 `kaz-shared`、
  round-display 输出白名单、memory paths；热重载（B6-4~B6-8）不属于 36 世，
  仍留给 37 世探针 / 38 世实现。

## 设置

- `enabled`：总开关。
- `includeSubagents`：旧/未知（非受控）子代理是否也走鲸鱼工作流，默认关。
  受控 v0.9 子代理恒受 ka-whale-workflow 治理，不受本开关限制。
- B5 起不再读取/展示旧 `reconstructionTools` / `taskToolSelectionEnabled` /
  `enable_tool` 设置。

## 存储

- 阶段状态：`~/.dsh/storages/ka-whale-workflow-stage.json`（version 6，
  含 sessions / contractState / workflowRuns /
  pendingStageInjection / subagentRoles；sessions 可存 `goal-active`，
  pendingStageInjection 可挂 `goal-active` / `working-resumed` 边界；
  B5 起不再读写 taskToolState 与旧 reconstruction/classification/goal-recovery）。
- Task plan：`~/.dsh/storages/ka-whale-workflow-task-plan.json`。
- 生命周期参考：`KazPlugins/ka-whale-workflow/PLUGIN_LIFECYCLE.md`。
- 私有插件候选注册表：`~/.dsh/storages/kaz-agent-managed-tools.json`
  （schema version 2；顶层 `candidates`）。
