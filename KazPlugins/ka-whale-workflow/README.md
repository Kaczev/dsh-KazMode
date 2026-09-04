# ka-whale-workflow

鲸鱼工作流组件（v0.8 Step A）：主/子两套新流程上下文 + `whale_report` 工作簿记。

- 主流程上下文（`[ka-whale-workflow main flow]`）：新会话首次注入一次，描述
  Minimal → 简单/复杂判断 → 质疑并找最小方案 → 明确工具/子代理需求 → 工作流 →
  Communication → 向主模型汇报候选记忆/技能建议。
- 子代理流程上下文（`[ka-whale-workflow subagent flow]`）：子代理首次注入一次，
  描述 Minimal → 质疑委派 → 检查主模型指定工具是否足够 → Working →
  Communication → 汇报候选经验/技能建议（不自写记忆/技能）。
- Goal 继续确认（`[ka-whale-workflow goal continuation]`）：存在非 complete goal
  时按轮注入，让 Kaczev 选择“继续原 Goal / 新任务 / 结束”。
- `whale_report`：Stable Main Surface 常驻工具。Step A/B1 后它只做工作簿记/模式记录
  （mode='goal' 或 normal）；v0.8 Step B1 起 mode='plan' 被拒绝。
- 阶段 system 段已删除：`ka-whale-workflow:prompt` 不再注册/改写；阶段内容只以
  追加历史消息进入。
- 阶段工具过滤已删除：ka-whale-workflow 不再按 reconstruction/classification/
  goal-recovery 收窄工具面。工具面稳定规则由 kaz-mode + kaz-shared 固定集执行。
- 兼容保留：内部 stage store 仍可保存旧阶段值，供 review/skill-review 与 Goal 恢复
  使用；但旧阶段文案不再注入。`reconstructionTools` / `taskToolSelectionEnabled` /
  `enable_tool` 相关设置仅作旧兼容读取，不再参与主模型工具面。

## 设置

- `enabled`：总开关。
- `includeSubagents`：子代理是否也走鲸鱼工作流，默认关。
- `reconstructionTools`：旧任务重构工具清单，保留仅作兼容 import/旧存储读取；不再
  作为阶段过滤清单。
- `skillAutonomyEnabled` / `skillAutonomyMaxChangesPerBoundary`：技能自省总开关与
  每安全边界变更上限（语义同前）。
- `skillPrivateRoot`：私有技能根目录。
- 终案 E Skill 生命周期：`skillAutoLifecycleEnabled` / `skillLifecycleUnusedDays` /
  `skillLifecyclePendingDays` / `skillLifecycleAuditIntervalHours` /
  `skillLifecycleMaxAutoActions`（语义同前，内部执行器不变）。

## 工具面

Step A 的 Stable Main Surface 定义在 `kaz-shared/lib/tool-lists.js`：
`KAZ_STABLE_MAIN_TOOLS` = `KAZ_BASE_TOOLS`(12) + Goal 三件套 +
`whale_report` + `subagent`。`send_message` / `list_agents` 暂不默认加入；
per-task 角色/toolFilter 投影留给后续受控委派 Step。

v0.8 Step B1：原生 Plan 已从 Kaz 实际移除，不再存在 Plan 显式模式边界例外；
主模型工具序列为纯 `minimal → Stable Main Surface` 一次变化。
