# round-display —— 每轮注入显示插件（Kaz 模式附属）

> **作用**：记录并展示每一轮 Kaz 联动/附属插件给模型发送的**白名单信息**。
> v0.9 B6 + 36.7（R-B6-2）起只显示七类：
> 1. 真实系统提示词快照（`system-prompt`）；
> 2. 工具面变化（`tool-surface`，36.9 起由 kaz-mode assemble 监听器上报的增删明细）；
> 3. Minimal → Stable Main/Sub Surface 的稳定边界（旧记录兼容）；
> 4. Goal 上下文通知（进入/退出/round/wrapup）；
> 5. 任务契约文本；
> 6. 子代理 report 摘要；
> 7. 记忆快照注入摘要。
>
> 不显示：每次 stage 切换、逐 request 的 whale_report 状态噪音、首轮记忆指引、
> first-round guidance 等非白名单内容。

只负责「显示」，不向模型注入任何内容：记录每一轮开始时 Kaz 模式联动/附属插件
给模型发送的上述七类信息，并在对话输入区右侧提供「本轮注入」按钮与面板，
按下后在对话框右侧显示本轮注入信息（格式：[插件名]>（信息内容）<）。

## 原理

- **轮次**：每次用户发一条消息 = 一轮（会话日志中最近一个 turn/start 的 data.turn）。
- **主动上报**：发布 `roundDisplay` 服务（`report({ agent, plugin, title, content, category })`），
  其它要发送信息的插件在发送时调用它告诉本插件要显示（best-effort：服务不存在
  时静默跳过）。2026-08-21 起不再监听组装段，展示内容全部来自主动上报。
- **子代理 report 路由（36.6 → 37.5）**：`ka-whale-workflow` 的
  `*_sub_whale_report` 仍不在子代理工具内直接写 round-display；父主线在
  `agent/pre-step` 收到 `subagent-report` / `subagent-settled` 后，以
  `category=subagent-report` 上报同一行摘要到 **主 agent 与 child subagent
  session 两处**（child id 取自消息 `source.senderSessionId`），因此主会话面板
  保持原有汇总，child 子代理页面也能看到自己的汇报摘要；child agent 结束/销毁后
  round-display 不删除其记录，child 历史页仍可读取。
- **输出白名单**：`category` 必须在
  `system-prompt / tool-surface / stable-boundary / goal-context / task-contract / subagent-report / memory-snapshot`
  七类中；不带 `category` 的旧上报按来源/内容回退分类（`kaz-system-prompt` → system-prompt，
  `round-minimal` 历史记录仍兼容为 tool-surface/stable-boundary，`kaz-mode` 新上报始终带 category）。
  非白名单记录不进入内存、不落盘、也不从历史恢复，阶段切换与 whale_report
  噪音因此不再出现。
- **面板通道**：专用 RPC（`/round-display`，loopback）。客户端面板打开时每 2 秒轮询：
  `list` = 当前轮；`history` = 全部轮次。
- **持久化（2026-08-21）**：记录按 agent × 轮次落盘到
  `<DSH_HOME>/storages/round-display-records.json`（`config.recordsStore` 可覆盖），
  **dsh 重启后 history 仍能看到此前各轮的注入记录**；每个 agent 最多保留
  200 轮，防抖 1s 落盘、卸载时 flush。恢复旧记录时同样套用白名单。

## 配置

纯方案 A：Kaz 会话下生效 enabled 由 kazMode 服务按会话读取（Kaz 面板开关），
settings.yaml 段仅作 standalone 兜底：

```yaml
round-display:
  enabled: true
```

**开关位置**：round-display 已被 kaz-mode 收编为被管理插件，
Kaz 模式面板（侧边栏底部「Kaz 模式」按钮 → 详细设置）里有独立的
`enabled` 开关（默认开）。关闭时**完全隐藏**——客户端连「本轮注入」按钮都不渲染，
宿主也不记录；按钮显隐按**当前会话的生效状态**实时跟随（Kaz 面板改动即时同步）。

## 客户端

按钮注册在 `conversation.input.right`（对话输入区工具行右侧，会话作用域）。
按钮与面板受该会话生效的 `round-display.enabled` 控制：关闭时整个组件不渲染；
开启时按原有逻辑自动判断显示（无注入记录时面板提示为空）。
