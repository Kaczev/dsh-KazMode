# round-minimal —— 首阶段极简（首次工具调用后恢复）

> **作用**：首次工具调用前只暴露 `memory_search` 一个工具，模型第一次调用工具后就恢复全部工具——让模型第一轮先查记忆，再开始实际任务，避免首轮就乱调工具、浪费上下文。

宿主侧插件：按「会话里是否已发生第一次工具调用」切换工具集（2026-08 重构，
替代旧的按对话轮次判定）：

- **首次工具调用前**（极简阶段）：模型可见/可调用的工具只保留 `firstRoundTools`
  （默认 `memory_search`），其余工具及 `tool:*` 指导段全部滤除；
  执行层对白名单之外的调用一律拒绝（纵深防御）。
- **首次工具调用之后**：工具列表恢复为组合/预设配置的全部工具。

阶段判定无状态且可靠：以会话日志里是否存在 `tool/call` 事件为准（agent-loop 每次
工具调用都会落盘该事件）。重启续接旧对话天然走全量模式（已有工具调用）。

> 不再注入任何提示段（2026-08：原 `round-minimal:policy` 的两条消息已删除；
> 对话开始时的注入消息改由 **first-round-hints** 插件提供）。

## 特性

- **首阶段极简**：首阶段只暴露 `memory_search`（先查记忆，再恢复全量工具）；
- **子代理排除**：默认不受影响（`includeSubagents: false`）——subagent / workflow /
  ralph 的子会话始终走全量模式；
- **对外信号**：发布 `roundMinimal` 服务（`enabled` / `firstRoundTools` /
  `isMinimal` / `turnOf`），状态变化时推送 `round-minimal/state` 事件——供 kaz-mode
  等消费方在极简阶段抑制"请先搜索记忆"之类的指引。

> 极简阶段默认只保留 `memory_search`，因此不依赖 shell；首次调用 `memory_search`
> 后立即恢复全量工具面。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
round-minimal:
  enabled: true
  firstRoundTools: [ memory_search ]  # 极简阶段工具白名单
  includeSubagents: false   # 子代理也走首阶段极简（默认关）
```

> 纯方案 A：Kaz 模式下生效配置由 kazMode 服务按会话读取（kaz-defaults.json +
> kaz-session-states.json），settings.yaml 段不再被 kaz-mode 改写、也不再自动补写。

## 阶段如何判定（无进程内状态，重启安全）

插件在任意一次组装/执行时，读取会话日志中是否已有 `tool/call` 事件：

- 无 = 极简阶段（首次工具调用前）；
- 有 = 全量阶段（工具已恢复）。

这个判定不依赖进程内记忆，插件热重载、dsh 重启后依然正确；天然免疫"续接旧对话"。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`round-minimal` 行（config: `enabled: true`）。改完**重启 dsh + 强刷页面**。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\round-minimal\probe-round-minimal.mjs"
```
（探针为旧版轮次行为编写，重构后仅作参考，可能过时。）

## 验收要点

1. 新对话首次请求的工具面只有 `memory_search`；
2. 模型第一次工具调用后的下一次组装，工具面恢复全部工具；
3. 重启续接旧对话（已有工具调用）直接全量模式；
4. 子代理（`includeSubagents: false` 时）始终全量模式。
