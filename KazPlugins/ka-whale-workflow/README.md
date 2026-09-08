# ka-whale-workflow

鲸鱼工作流组件（v0.9/v0.10，31 世 + 32 世 B3/B3.5 + 35 世 B5 清理 + 36 世 B6 部分收尾 + 36.5–37.5 纠正范围 + 38 世热重载 + 39 世 v0.10 纠正：persona 固定枚举 / finalPlanPayload 原子校验 / 子代理尾部合并 / per-project per-run task-plan + plan_read / work-log / memory auto-load 文档同步；Goal 模式已移除）。

## 范围

- 主/子阶段机：英文 stage id，Allowed tools / Can advance to / Task 与 v0.9
  表格一致；37.5 移除 `plugin-preflight`，2026-09 用户决策再移除 `decide-goal`
  （Goal 模式不再使用，因已有 subagents 可承担同类多轮/续接工作）。当前主流程为
  `assess-complexity → challenge-plan → decide-tools-before-writing-plan → write-plan
  → working → memory-maintenance → plugin-maintenance/communication`；
  受控子代理只含 worker / memoryMaintainer / pluginMaintainer 三角色。
- Goal 模式移除：ka-whale-workflow 不再提供 `decide-goal`/`goal-active`/
  `working-resumed` 生命周期，不再识别 `/goal` 手动命令旁路；`whale_report`
  的 `mode='goal'`/`objective`/`max_goal_rounds` 一律返回
  `workflow-stage-deny: ... Goal mode has been removed`。历史 stage store 中残留的
  `goal-active`/`working-resumed` 字符串只按旧数据处理，新一轮真实用户消息会防御性
  回到 `assess-complexity`，不保留任何 Goal 专用文案或边界注入。
- `tools/pre-execute` 软闸门：主模型与受控 v0.9 子代理在当前 stage 调用非
  Allowed tools 返回 `workflow-stage-deny`，不视为模型失败惩罚。
- 双层语义（M3.3 + Minimal 收口）：stage `allowedTools` 是当前阶段的软闸门，
  不是首轮 Minimal 列表。主 `assess-complexity` 的 `allowedTools` 为
  `memory_search` / `context_search` / `context_read` / `whale_report`；受控子代理
  初始 stage 为其 planning stage（worker=`challenge-plan`，
  memoryMaintainer=`plan-memory`，pluginMaintainer=`plan-plugin`），allowedTools 按
  lib/stage-defs.js 中的 planning 面放行（read/grep/glob/memory/context + 各自
  report 工具等），不依赖首轮 Minimal 列表，也不放 `context_compress`（compress
  属于主 compass_context_before_communication / Stable 面；受控子代理在合并 terminal
  `compress_context_then_communication` 才使用）。主 `assess-complexity`
  不放 `ask_user_question`（澄清需求先推进 `challenge-plan`）。
- 首轮 Minimal 与主/子代理对齐：真正的首轮 Minimal 由 kaz-mode `firstRoundTools` /
  `V09_SUBAGENT_ROLE_MINIMAL_TOOLS` 在“首次工具调用前”独立收口：
  主与受控子代理都是 `memory_search` + `context_search`。主模型和受控子代理在
  stage=idle、尚无首次 tool/call 时都**不注入完整 stage 正文**；pre-step 只注入一次
  `[ka-whale-workflow first-round]` startup hint（source.form=`startup-tool-hint`），
  明确要求先调用 `memory_search` / `context_search` 一次。首次 tool/call 后：
  主模型进入 `assess-complexity`；受控子代理由 `session/event` 把角色记录
  `minimalDone` 置 true 并进入 role 首阶段，随后 pre-step 才注入该 stage 正文
  （不再含 Minimal 行）。`minimalDone` 持久化在 stage store，因此子代理经父主
  `send_message` resume 后即使会话 tool/call 事件不可见，也不会重新回到 Minimal。
- 受控 v0.9 子代理：`ka_sub_whale` 创建的
  `worker`/`memoryMaintainer`/`pluginMaintainer` 不受
  `includeSubagents=false` 跳过。新受控子代理在首次 tool/call 前保持 stage=idle +
  Minimal；首次 tool/call 后才自动进入 role 首阶段
  （worker=`challenge-plan`，memoryMaintainer=`plan-memory`，
  pluginMaintainer=`plan-plugin`），按 pending stage
  注入 role 专属 `[ka-whale-workflow <role-stage>]` 文本，并由 `tools/pre-execute`
  按该 role/stage 的 Allowed tools 软闸门约束；plugin 的 create/update/retire
  阶段注入携带实际 `lifecyclePath`。受控角色不再注入通用 subagent-flow 常量
  （role Persona 已由 ka_sub_whale 的 `request.persona` 提供，并被
  kaz-system-prompt 原样保留）；旧/未知子代理在
  `includeSubagents=true` 时只进入 workflow stage 外壳，不再注入旧通用
  subagent-flow。受控子代理的 `subagentRoles` 记录在 unload/ready/agent/disposed
  期间**保留不删**（DSH continuable 子代理每轮结束可能触发 dispose/unload，删除
  会让父主 send_message 恢复时丢失受控角色与 pending 注入）；真正已移除子代理的
  脏记录由 memoryMaintainer 复用对账经 `listChildren` 清理。
- 阶段终态：主 `communication` allowedTools = `whale_report` + `plan_read`；
  受控子代理不再有 subagent `communication`/`compass_context_before_communication`
  定义，统一 terminal `compress_context_then_communication`
  （`context_compress` + 各自 report 工具）。
- B6 收口：`KAZ_ROLE_PROMPTS`（v0.9 §9.1–9.5）作为全量 Persona 唯一源存放在
  `kaz-shared`，本组件 `V09_ROLE_PERSONAS` 由它派生；旧的一次性
  `MAIN_FLOW_TEXT` / `SUBAGENT_FLOW_TEXT` 导出已删除。当前主 Persona 应用：`kaz-system-prompt` 每个
  step 把 `deployment:persona` 整段设为 `KAZ_ROLE_PROMPTS.main`（含完整首句/末句），
  ka-whale-workflow 不再注册 `ka-whale-workflow:main` system 段，旧
  `KAZ_MAIN_ROLE_BODY` 机制已退役；受控 v0.9 子代理的 `request.persona` 携带当前
  `KAZ_ROLE_PROMPTS.subagent.*`，`kaz-system-prompt` 会原样保留该角色 Persona。
  因此真实 system 里 main/role guidance 都只出现一次，也不再重复 DeepSeek
  base 的 Keep-gray 段落。
- 子代理 report 的 round-display 摘要（单一 subagent-settled 通道）：子代理不再由
  `*_sub_whale_report` child-side 写摘要；完整报告由子代理作为最终消息写出并结束
  回合，父主线 `agent/pre-step` 收到 `subagent-report` / `subagent-settled` 后以
  category=`subagent-report` 同时记录到主 agent 与 child subagent session（child id
  取自 `source.senderSessionId`）。因此主会话和 child 页面都能看到该次汇报；child
  agent 结束后 round-display 仍保留 child 记录。
- 阶段注入：进入 v0.9 stage 时追加 `[ka-whale-workflow <stage-id>]` 上下文，携带
  Allowed / Can advance / Task，并在 write-plan/working/memory-maintenance/
  plugin-maintenance 阶段携带 `taskPlanPath`，在 create/update/retire-plugin 阶段携带
  `lifecyclePath`，在 decide-tools-before-writing-plan 阶段携带当前私有插件候选目录。
- 阶段级 Context 注记：`STAGE_CONTEXT_NOTES`（lib/stage-defs.js）为部分 stage
  定义 Context 提醒；`stageInjectionText` 在有注记的 stage 的 `Task:` 行后输出
  `Context: <text>`，无注记不输出。覆盖 main 的 assess-complexity/challenge-plan/
  communication、worker 的 challenge-plan/compress_context_then_communication 与
  memoryMaintainer/pluginMaintainer 的 compress_context_then_communication：涉及
  早前会话内容时先 `context_search` 再 `context_read` 掌握/复现背景；main.communication
  另在会话冗长收尾前先 `context_compress suggest` 预览（manual 优先、auto 兜底）。
- `compass_context_before_communication`（主模型阶段保留）：仅
  `context_compress` + `whale_report` + `plan_read`，只能去 communication
  （可从 main write-plan/memory-maintenance/plugin-maintenance 进入）。
  受控子代理不再使用该阶段；其压缩+终报合并到
  `compress_context_then_communication`。
- B2.5 重启语义（main-role）：Minimal 只在整段 session 第一次 tool/call 前发生；
  后续 workflow-run 重新进入主 `assess-complexity` 但不重复 Minimal；
  主 `assess-complexity -> communication (no-tool-call)` 是合法路径。
- 36.5 用户消息路由：真实用户消息在非终态活动阶段保留当前阶段，不重置成
  `assess-complexity`；只有 `idle`/`done`/`end`/`communication`/
  `compress_context_then_communication` 或历史 `goal-active`/`working-resumed`
  旧值才重置。
- 子代理回传不触发新一轮：DSH `subagent-report` / `subagent-settled` 等内部消息
  不是真实用户消息，`isUserMessage` 返回 false，不会把主模型 working 重置成
  `assess-complexity`。
- Task plan：项目模式写入 `<project>/.dsh/storages/ka-whale-workflow/task-plans/`
  （每 run 一个 `<session>-<runId>.json` + `current.json`；无项目根时退回全局
  `ka-whale-workflow-task-plan.json` legacy 单文件）；
  `decide-tools-before-writing-plan` 不得写 draft planItems（会拒绝）；task plan 只在
  `write-plan` 通过 `whale_report(finalPlanPayload)` 创建/定稿（finalized）；
  主模型用 `plan_read` 结构化读取当前 run plan + work-log（不要用 read 直接读原始 JSON）；
  每 run 另有 `<session>-<runId>.work-log.json`，自动记录已完成子代理的 terminal
  full report（role/planItemId/summary/report/seq）；legacy 模式不写 work-log；
  memory-maintenance/plugin-maintenance 不能创建 task plan，只能经 write-plan
  读取/改约；
  plan item `persona` 允许 `main` + 三子代理角色；`ka_sub_whale` 只接受
  finalized planItemId 且 persona 必须是三子代理角色之一，`persona=main` 返回
  结构化 `main-persona-delegation-denied`。
- B3 受控委派：`ka_sub_whale` 按 finalized `planItemId` 读取
  persona/task/assignedTools，校验 assignedTools 来源
  （tool-jobs + available 私有插件候选）与数量（>6 提醒、>8 拒绝），
  计算 role Stable Base + assignedTools 最终 toolFilter，先以 caller-reserved
  `childId`（randomUUID）写入 stage store 的 subagentRoles，再通过
  `ctx.subagents.startContinuable({ childId, provider: 'spawn', maxDepth: 1 })` 创建
  continuable child（成功后幂等重写角色记录；启动失败删除预写记录）；
  模型只能传 `planItemId`。
- 36.5 working 委派语义：`persona=main` 由主线执行，子代理 persona 经
  `ka_sub_whale` 委派；主线监控/验证/改约并只在计划外提问；working 后若仍有
  `memoryMaintainer`/`pluginMaintainer` items，必须先走
  `memory-maintenance`/`plugin-maintenance` 再 communication。
- 36.6 事件驱动等待：`ka_sub_whale` 创建 continuable child 后，主线不使用
  `pwsh sleep` / 轮询 `list_agents` 等待；应结束当前回合，等子代理最终
  subagent-settled 消息到达主会话再继续。`list_agents` / `send_message` 不是等待
  原语；主 Persona、working/memory-maintenance/plugin-maintenance 注入与
  `ka_sub_whale` description/output 都明确该口径。
- 主子代理相处模式（单一 subagent-settled 通道）：`*_sub_whale_report` 是子代理
  唯一的硬停/汇报闸门——调用它（可选 `nextStage` 推进）后置 `awaitingParent` 并
  硬停；随后子代理把完整报告作为**最终消息**写出并结束回合，父主以单条
  `subagent-settled` 收到。父主审查后用一次 `send_message` 恢复子代理（子代理处于
  terminal `compress_context_then_communication` 时，该回复开启该角色新的一轮：
  worker=`challenge-plan`、memoryMaintainer=`plan-memory`、pluginMaintainer=`plan-plugin`）。
  父主不得假设子代理在 report 工具调用后仍继续运行。
- 子代理多轮复用：同一 memoryMaintainer 子代理可被多轮复用（`ka_sub_whale` 对同
  parent + 同 role + finalSurface 一致且终态空闲的 child 自动 followup 下一轮；每轮从
  plan-memory 开始，前一轮上下文仍在但本轮为独立委派）。worker/pluginMaintainer
  是否复用由主代理决定：可对同 surface+空闲 child 直接 `send_message`，否则
  `ka_sub_whale` 新开。
- 36.7 challenge-plan 批评纪律：主/worker 的 challenge-plan 阶段要求先批评、
  识别真实弱点、不制造批评；主 Persona/working 要求批判性评估子代理报告与
  批评、不盲从，worker Persona 要求先批评委派、识别真弱点、不盲从。阶段定义与
  `KAZ_ROLE_PROMPTS` 同步更新，避免文档/代码漂移。
- 36.8 worker 不提前终止：worker `challenge-plan` 只可推进到 `working`；
  challenge-plan 是批评/澄清阶段，不是执行阶段，完整 working 文件工具面
  （edit/write/pwsh/read）在 `working` 才授予；worker 不得在到达 working 前报告
  工具不足，也不再有从首阶段直接跳 communication 的捷径。
- 36.8 mandatory memory-maintenance gate：主 `working` 只可推进到
  `write-plan`（改约）或 `memory-maintenance`；`working → communication` 与
  `working → plugin-maintenance` 已移除，`whale_report` 从 working 的默认推进
  目标是 `memory-maintenance`。working 完成后总是先进入 memory-maintenance，
  再按 plugin work 进入 plugin-maintenance 或 communication。
- 36.8/37.5 stage-persona mapping：`ka_sub_whale` 的委派阶段与 persona 固定映射
  （working→worker、memory-maintenance→memoryMaintainer、
  plugin-maintenance→pluginMaintainer）；不匹配返回结构化 `stage-persona-mismatch`。
- 36.8 task splitting：write-plan 必须为每个 coherent task 建独立 planItem；
  working 逐个委派 worker planItems；memory/plugin planItems 留给对应维护阶段；
  受控委派只覆盖 worker / memoryMaintainer / pluginMaintainer 三角色。
- B3.5：`[ka-whale-memory Review]` / `[skill Review]` 复盘边界已移除，任务结束
  不再注入两类标题。
- 新工具注册：`ka_sub_whale` 实际受控委派层 + 三个 `*_sub_whale_report`
  （单一 subagent-settled 通道：每个工具按角色不同流程推进 stage，可选 `nextStage`
  用于推进，省略 `nextStage` 只置硬等门；工具不再接收 `output`、不调用 DSH
  `reportFrom`，完整报告由子代理最终消息携带）；
  `list_agents / send_message / interrupt_agent` 由 DSH subagent-control 提供，
  ka-whale-workflow/kaz-shared 负责 Stable Main Surface 放行。
- 子代理 report 硬等门：`*_sub_whale_report` 无论是否带 `nextStage` 都把
  subagentRoles 记录的 `awaitingParent` 置 true，工具结果追加
  `Stage advanced; now output your full report as your final message and end the
  turn; parent receives it as subagent-settled; do not call further tools.` 文案；
  受控子代理 `awaitingParent=true` 期间 tools/pre-execute 拒绝其继续调用任何工具
  （含再次 report），返回结构化 `subagent-report-wait-deny`；父主模型 `send_message`
  （DSH source `kind=coordinator`/`form=relay`）到达时清门——当前 stage 为
  terminal `compress_context_then_communication` 且 pending 已被消费（terminal full
  report 已发出）时重置为该角色初始阶段（worker=`challenge-plan`、
  memoryMaintainer=`plan-memory`、pluginMaintainer=`plan-plugin`）开始新的一轮；
  merged 中间态（pending 仍等于该 stage）或其它非终态仅清 `awaitingParent`、stage
  保持不变继续当前轮。
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
  pendingStageInjection / subagentRoles；subagentRoles 每条记录含可选布尔
  `awaitingParent`（旧记录缺省按 false 读，version 保持 6）；Goal 模式移除后
  sessions/pendingStageInjection 不再写入 `goal-active`/`working-resumed`，历史残留
  值按未知丢弃或防御回 `assess-complexity`；不再读写 taskToolState 与旧
  reconstruction/classification/goal-recovery）。
- Task plan：项目模式 `<project>/.dsh/storages/ka-whale-workflow/task-plans/`
  （`<sessionId>-<runId>.json` + `current.json`；current pointer
  `{version:1, sessionId, runId, updatedAt, planFile}`）；同目录
  `<sessionId>-<runId>.work-log.json` 记录 completed subagent terminal reports；
  无项目根或 `config.taskPlanStore` 显式覆盖时退回
  `~/.dsh/storages/ka-whale-workflow-task-plan.json` legacy 单文件（legacy 不写 work-log）。
- 生命周期参考：`KazPlugins/ka-whale-workflow/PLUGIN_LIFECYCLE.md`。
- 私有插件候选注册表：`~/.dsh/storages/kaz-agent-managed-tools.json`
  （schema version 2；顶层 `candidates`）。
