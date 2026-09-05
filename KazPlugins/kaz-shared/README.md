# kaz-shared —— Kaz 模式工具清单 / 工具控制面板的单一事实源（依赖包，非 cordis 插件）

> **作用**：Kaz 全家桶的公共依赖包——Kaz 工具清单（出厂默认/首轮工具/默认禁用/被管理插件目录/默认 persona）、工具控制面板状态模型和工具面计算的唯一来源，其它插件不再各自维护副本。

`kaz-mode` / `ka-whale-memory` / `plugin-filter` 的公共依赖。
**纯 ESM 模块**（`lib/tool-lists.js`），不注册任何服务、不注入任何提示段，只是常量 + 纯函数。
36.9：round-minimal 已删除，不再作为公共依赖消费者。

## 职责

Kaz 模式的工具清单 / 工具控制面板模型**全部集中在这里**，其它组件不再各自维护副本：

| 导出 | 谁用 | 作用 |
| --- | --- | --- |
| `TOOL_WHITELIST` | 旧版兼容 / kaz-memory（可用性兜底） | 旧的官方工具默认清单（新代码优先用 `TOOL_PLUGIN_CATALOG` + `TOOL_PLUGINS`） |
| `TOOL_PLUGIN_CATALOG` / `TOOL_PLUGINS` | kaz-mode（统一工具面 factory） | 官方工具按插件分组的出厂目录 + 插件能力开关（tool-fs / tool-pwsh / ...） |
| `normalizePluginEnableDict` / `normalizeToolCatalog` / `mergePluginEnableDicts` / `mergeToolCatalogs` / `buildToolUniverse` / `computeEffectiveToolState` / `computeToolPluginSurfaceFromEffective` | kaz-mode 服务端/面板 | 官方+外置统一的四文件模型归一化、合并与工具面展开 |
| `effectiveToolWhitelist(whitelist)` | kaz-memory / 旧版兜底 | 旧数组白名单去重 |
| `computeSurface(inputs)` | kaz-mode 组装层 | 计算某代理此刻的 Kaz 工具面 |
| `DEFAULT_FIRST_ROUND_TOOLS_MEMORY_ON` / `_MEMORY_OFF` / `DEFAULT_FIRST_ROUND_TOOLS` | kaz-mode | 首阶段工具白名单：kaz-memory 开 = `memory_search`；关 = `pwsh`/`read`/`edit`；兜底 = MEMORY_OFF |
| `resolveFirstRoundTools({ kazMemoryEnabled })` | kaz-mode / computeSurface | 按 kaz-memory 启用状态解析首轮工具白名单（统一管理点） |
| `DEFAULT_DISABLED_TOOLS` | plugin-filter / kaz-mode | 默认禁用清单默认值 |
| `MANAGED_PLUGINS` / `FIXED_PERSONA` | kaz-mode 面板 | 被管理插件目录 / 默认 persona（实际提示词由 kaz 预设脚本控制） |
| `KAZ_BASE_TOOLS` / `KAZ_STABLE_MAIN_TOOLS` / `KAZ_V09_MAIN_TOOLS` / `KAZ_V09_SUBAGENT_ROLE_TOOLS` / `KAZ_SUBAGENT_BASE_TOOLS` / `stableMainSurface` / `stableSubagentSurface` | kaz-mode / ka-whale-workflow（v0.9） | Stable Main Surface = v0.9 §1.1 固定 19 项（无旧 create_goal/subagent）；子代理 role 面与报告工具；B5 后旧 Goal/subagent 工具常量已删除 |
| `KAZ_ROLE_PROMPTS` | ka-whale-workflow / kaz-mode / kaz-system-prompt | v0.9 §9.1–9.5 全量 Persona 唯一收口（`main` + 四个 subagent 角色）；主会话真实系统由 kaz-system-prompt 把 `deployment:persona` 设为 `KAZ_ROLE_PROMPTS.main` 全文，旧 `KAZ_MAIN_ROLE_BODY` / `ka-whale-workflow:main` 第二段机制已退役；stage-defs 的 `V09_ROLE_PERSONAS` 与 main/subagent flow 文本由此派生；36.5 已同步 delegation-first（persona=main 主线执行 / subagent 委派）与 maintenance 路由语义；36.6 已同步事件驱动等待（`ka_sub_whale` 后不 sleep / 不轮询 `list_agents`，结束回合等 report/finished；`list_agents`/`send_message` 非等待原语）；36.7 已同步 challenge-plan 批评纪律（先批评/识别真弱点/不制造批评；主批判性评估子代理批评、不盲从；worker 先批评委派、不盲从）；36.8 已同步 worker 不在 challenge/check-tools 提前报告工具不足、主 working 后强制 memory-maintenance、write-plan 按 coherent task 拆分 planItems、working 逐个委派 worker planItems；37.5 已从 main Persona 移除 plugin-preflight/pluginCreator 主流程委派（pluginCreator 仅保留子代理角色定义）；子代理四条经 `request.persona` 注入受控子代理并由 kaz-system-prompt 原样保留 |
| `KAZ_TASK_PLAN_STORE_PATH` / `KAZ_PRIVATE_PLUGIN_LIFECYCLE_PATH` / `KAZ_PRIVATE_PLUGIN_CANDIDATE_PATH` | ka-whale-workflow / kaz-mode 探针 | v0.9 task plan 独立存储绝对路径；私有插件生命周期参考文件绝对路径；私有插件候选注册表（与 agent-managed 同源）绝对路径 |
| `V09_SUBAGENT_ROLE_IDS` / `V09_SUBAGENT_ROLE_MINIMAL_TOOLS` / `V09_SUBAGENT_ROLE_STABLE_BASE` / `V09_SUBAGENT_ROLE_PERSONA_REFS` / `V09_SUBAGENT_ROLE_TOOL_FILTERS` / `computeV09FinalSurface` / `resolveV09AssignedTools` | ka-whale-workflow / kaz-mode（v0.9 B3） | 四角色（worker/memoryMaintainer/pluginMaintainer/pluginCreator）的 Minimal/Stable Base/personaRef/toolFilter；assignedTools 来源（tool-jobs + 私有插件候选）与数量校验；最终角色面计算 |
| `normalizeAgentManagedCandidateRegistry` / `privatePluginCandidateToolNames` / `availablePrivatePluginCandidateToolNames` / `upsertPrivatePluginCandidate` / `removePrivatePluginCandidate` | ka-whale-workflow / 插件生命周期（v0.9 B3） | 候选注册表 schema version 2：顶层 `candidates`（tool/description/source/available）的归一化/查询/新增/更新/退休同步 |
| `toolCallable` | ka-whale-workflow / kaz-memory | 工具可用性判定（B3.5 已移除 Review 文案） |
| `MEMORY_READ_TOOLS` / `KAZ_MAINTENANCE_ONLY_TOOLS` / `SUBAGENT_MAINTENANCE_MEMORY_WRITE_TOOLS` / `normalizeToolNameList` | kaz-mode / ka-whale-workflow | 记忆读工具与只进维护角色白名单的记忆写工具；B5 后旧 BASE_TOOLS / optional 池 / enable_tool 已删除 |
| `V09_TOOL_JOBS` / `V09_SUBAGENT_ROLE_IDS` / `normalizeV09Role` / `v09MinimalToolsForRole` / `v09StableBaseForRole` / `v09ToolFilterForRole` / `v09AssignedToolsSubsetOfMain` / `assertV09RoleWriteToolRestrictions` | ka-whale-workflow / kaz-mode（v0.9 B3） | 四角色固定层与 assignedTools 校验；B5 后旧 toolCreator/retriever 已退役 |
| `estimateToolsSchemaTokens` / `surfaceSnapshots` / `surfaceTransitionCount` / `budgetReviewPoint` | Kaz 6.0 Step 4 缓存/噪音验收 | schema token 固定密度估计、request/header 工具面去重快照与变化次数、Task Surface/`KAZ_BASE_TOOLS` 预算复审点（纯函数） |
| `MAINTENANCE_REPORT_FIELDS` / `normalizeMaintenanceReport` / `maintenanceReportToText` / `parseMaintenanceReport` / `shortMaintenanceReport` | Kaz 6.0 Step 2 维护子代理试点 | 维护子代理返回“结论/证据/失败与阻塞/下一步建议”结构化短 report；主模型不重读全文 |
| `validatePhysicalDeletionRequest` / `newDeletionAudit` | Kaz 6.0 Step 2 删除闸门 | 物理删除必须主模型批准 + 删除前备份 + 审计；执行者固定 maintenance-subagent |
| `hotLoadProbe` / `hotLoadVerdictText` | Kaz 6.0 Step 2 受控热加载 | 统一记录 DSH 是否支持运行时私有插件注册；不支持时一律“下一任务/重启后生效”，不扩展当前 Task Surface |
| `SKILL_PRIVATE_DIR_NAME` / `SKILL_PROCESS_DIR_NAME` / `SKILL_BOUNDARY_MAX_CHANGES` / `SKILL_LIFECYCLE_TOOLS` / `skillLifecycleCallable` | ka-whale-workflow | 私有插件生命周期常量与技能闭环基础能力判定（B3.5 已移除 `skillReviewGuidanceText` / `SKILL_EVIDENCE_MIN`） |
| `SKILL_LIFECYCLE_VERSION` / `SKILL_LIFECYCLE_STATUSES` / `SKILL_LIFECYCLE_DEFAULTS` / `normalizeSkillLifecycle` / `normalizeSkillLifecycleDefaults` / `skillKeyOf` / `auditSkillLifecycle` / `projectRegistryFromLifecycle` / `transitionAllowed` | ka-whale-workflow（内部执行器） | 终案 E 全自动 Skill 生命周期纯函数层：v2 lifecycle 归一化（损坏 → feature off）、闲置/失败/补丁审计建议、registry 工具列表投影、状态机白名单；只输出建议，不写文件 |
| `SUBLIMATION_THRESHOLD` / `KAZ_CONTEXT_RENDER_ORDER` / `KAZ_CONTEXT_CACHE_SCENARIOS` / `KAZ_CONTEXT_NATIVE_FALLBACK_STRATEGY` / `normalizeCacheScenario` / `classifyCacheScenario` / `cacheMeasurementMode` / `hFull` / `hReadProxy` / `compressionRatioPass` / `renderOrderValid` | Kaz7.0 M0 后续压缩/缓存验收 | 最终基准 v1.1 纯模块：升华 N=4、渲染顺序判据、A/B/C/D cache 可用性矩阵、原生 1M 兜底策略、H_full/H_read_proxy/R 等事后测量纯函数；不设任何 MC/token 触发或保留预算 |

> **官方/Kaz 分类修改点**：`lib/tool-plugin-catalog.js`。外置插件数据（手动添加）保存在用户目录 storages 的 `other-*.json`；项目专属开关调整：官方/Kaz 写项目 `tool-plugin.json` / `tool-plugin-catalog.json`，外置写项目 `other-*.json`，**不写在源码里**。
>
> **v0.8 Step B2**：`kaz_tool_auto_on` 已整体退役。`lib/tool-auto-on.js` 已删除，
> `ka_tool_auto_on_setting.json` 不再被 Kaz 读写（旧文件仅在备份区保留）。

## 工具面语义（2026-08 统一）

- **官方/外置统一为“工具控制面板”**：Kaz 工具面 = `原设置(代码 + 用户 other-*) → 用户默认 → 项目设置(项目 other-* + 项目 tool-plugin 文件)`
  四文件合并后的 enabled 工具；新插件/新工具不会自动写入，需要手动添加（写入用户 `other-*`，共享所有项目）；开关调整写项目对应文件（专属）。
- **官方出厂**：`TOOL_PLUGIN_CATALOG` + `TOOL_PLUGINS`（tool-fs / tool-pwsh / ... / kaz-memory）。
- **旧 `kaz-mode.toolWhitelist` 已弃用**：kaz-mode 不再读取/写入 settings.yaml 的该字段；
  `TOOL_WHITELIST` / `effectiveToolWhitelist` 仅保留给 kaz-memory 可用性兜底等旧路径。
- **Kaz 模式**（kaz-mode.enabled=true，v0.9）：
  - 稳定阶段主模型 = `stableMainSurface()` = `KAZ_V09_MAIN_TOOLS`（v0.9 §1.1
    固定 19 项：含 `ka_sub_whale`/`list_agents`/`send_message`/`interrupt_agent`/
    `get_goal`/`update_goal`/`whale_report`；不含旧 `create_goal/subagent`）；
  - 子代理稳定阶段 = `stableSubagentSurface()`（保守 Base 兜底；v0.9 受控 role 面由
    `KAZ_V09_SUBAGENT_ROLE_TOOLS` 表达，供 ka_sub_whale 使用）；
  - 首阶段（kaz-mode 核心 `minimalPhase=true`）只保留 `firstRoundTools`；
    为空时按 `resolveFirstRoundTools({ kazMemoryEnabled })` 自动解析——Kaz 下
    ka-whale-memory 恒开 → `memory_search`；
  - 原生 Plan 已移除，`stableMainSurface()` 不接受 Plan 自动放行参数。
- **记忆工具**：Kaz 下 ka-whale-memory 恒开，旧项目关闭状态不再从 Kaz 固定面剔除；
  非 Kaz 模式仍由 kaz-mode 按 agent 会话开关从工具面剔除。
- **非 Kaz 模式**：本模块不干预工具面（由标准模式决定）。

## 安装

```powershell
# profiles/web/package.json 的 dependencies 加入：
#   "kaz-shared": "file:KazPlugins/kaz-shared"
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm install --legacy-peer-deps --no-audit --no-fund --save ./KazPlugins/kaz-shared
# 或手工建 junction：
# New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\kaz-shared" -Target "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared"
```

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-tool-lists.mjs"
# 期望输出：KAZ-SHARED PROBE OK
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-step4-metrics.mjs"
# 期望输出：STEP4-METRICS PROBE OK
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-skill-guidance.mjs"
# 期望输出：SKILL-GUIDANCE PROBE OK
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-subagent-policy.mjs"
# 期望输出：SUBAGENT-POLICY PROBE OK
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-maintenance-report.mjs"
# 期望输出：MAINTENANCE-REPORT PROBE OK
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-shared\probe-hot-load.mjs"
# 期望输出：HOT-LOAD PROBE OK
```
