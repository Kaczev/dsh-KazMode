# ka-whale-workflow

鲸鱼工作流组件：用户消息后先「任务重构」，再「任务分类」，然后放行 Kaz 白名单。

- 任务重构：工具面 = 「ka-whale-workflow 配置面板代码框清单 ∩ Kaz 白名单」+ 自动启用面板临时放行的 `whale_report`。
- 任务分类：工具面 = `whale_report`；`whale_report({mode})` 统一启动 plan/goal 模式。
- `whale_report`：重构/分类各调用一次，向插件汇报阶段完成；分类时可传 `mode`（`normal` / `plan` / `goal`，goal 需带 `objective`）。plan 模式由 `whale_report` 内部通过 `create_plan` 工具（planning isolate 组内）切换，因此分类工具面保持只有 `whale_report`。
- 补充信息：第 2、3、4……轮（turn≥2、模型不在运行）直接重新进入「任务重构」。**插话（模型运行中同一轮中途追加消息）不改变当前工作流阶段**。**Plan/Goal 模式激活时用户回复不进入任务重构**，保持在当前模式（goal 模式含 paused）。
- round-minimal 优先：首次工具调用前不进入重构，第一次工具调用后立刻进入。
- 首轮介绍：新对话首个真实用户消息（turn=1）注入一次 `[ka-whale-workflow overview]`，简述「任务重构 → 任务分类 → 执行」全流程；与 first-round-hints 同风格、由本插件自持，位置早于 TaskReconstruction 块。续接旧对话、插件关闭、`/plan` `/goal` 命令旁路、子代理（默认）不注入。
- 阶段状态写入插件自己的 JSON 存储（`~/.dsh/storages/ka-whale-workflow-stage.json`，按 session id 索引），重启/续接会话自动恢复；**不再写会话事件**（自定义会话事件会让 dsh 重载日志时拒绝整条会话）。
- 复盘（方向1）：任务进入 `done` 后，在 **Normal 任务完成**、**Plan 结束**、**Goal 结束**节点各注入一次 `[ka-whale-memory Review]` 紧凑指引（同一逻辑任务运行最多一次，先到边界获胜；且每 session 每类型一次）；指引要求模型只在有实质变化/新结论时写 1–2 条 `memory_save`，默认 `CANDIDATE`，无证据不得标 `high`，无实质结论不写。
- 技能自省（二阶段）：同一批安全边界注入独立的 `[skill Review]`（`form=skill-review`），引导模型自主判断是否 Create / Update / Retire 一个可执行 skill（证据 ≥2、每边界 ≤1 变更、不批量）；与 memory review 相互独立、独立 per-session per-kind 去重；仅当 `skillAutonomyEnabled` 为 true 且 `write`/`edit`/`pwsh`/`safe_json_write` 至少一项可用时注入。过程文档在私有 `KazPrivatePlugins/process`，插件本体在私有 `KazPrivatePlugins/`，不再使用无法定位的 `project process folder` 占位词。Create 的完成态 = CANDIDATE + 私有插件 + probe + 注册；只写 CANDIDATE 不算完成、不消耗变更预算；纯知识/配置 runbook 只写 memory，不建 CANDIDATE skill。

## 设置

- `enabled`：总开关（Kaz 面板可开关）。
- `includeSubagents`：子代理是否也走工作流，默认关。
- `reconstructionTools`：任务重构工具清单，Kaz 面板中以代码框展示/编辑（与其它输入框同底色，逗号分隔，默认八个工具）。
- `skillAutonomyEnabled`：自主 skill 管理总开关，默认开；关闭后回到一阶段“按需自升级”。
- `skillAutonomyMaxChangesPerBoundary`：每个安全边界允许的技能变更数上限，默认 1（v2.0 硬上限为 1，面板设更大值会被钳制回 1）。**1 = 一个完整 Create 生命周期**（CANDIDATE + 私有插件 + probe + 注册）；CANDIDATE-only 不算一次 Create、不消耗该预算。
- `skillPrivateRoot`：私有技能根目录，默认空；为空时按 `%DSH_HOME%\profiles\web\KazPrivatePlugins` 解析（过程目录在其下的 `process`）。
- 终案 E 全自动 Skill 生命周期（内部执行器，不新增用户可见工具）：
  - `skillAutoLifecycleEnabled`：总开关，默认 `true`；关闭 = 不埋点、不审计、不自动 Retire/提交，回到现状。
  - `skillLifecycleUnusedDays`：未用多少天进入 `retire-pending`，默认 `60`。
  - `skillLifecyclePendingDays`：`retire-pending` 宽限天数，默认 `7`；宽限后仍未用才 `retired`。
  - `skillLifecycleAuditIntervalHours`：后台周期审计间隔，默认 `24`。
  - `skillLifecycleMaxAutoActions`：每周期自动动作数，默认 `1`（硬性钳制为 1）。
  - 埋点：`tools/result` 只统计 `exec.parent === undefined` 且 agent-managed/lifecycle 已登记工具；内存更新 → `ctx.debounce` 落盘 → 插件卸载前 flush。
  - 状态存储：`~/.dsh/storages/kaz-skill-lifecycle.json`（意图源）与 `kaz-skill-lifecycle-audit.jsonl`（机器审计）；`kaz-agent-managed-tools.json` 只做投影同步。
  - 自动动作先 dry-run / busy 锁 / 每轮 ≤1 / 先备份再原子写 / 审计 JSONL；`retired` 不硬删任何目录与 versions。

## 工具自动启用

`whale_report` 不在默认白名单里，由「Kaz 模式工具自动启用」面板的「鲸鱼工作流」临时放行（重构 + 分类）。`create_goal` / `create_plan` 不再由工作流自动放行；分类的模式启动由 `whale_report` 内部完成。
