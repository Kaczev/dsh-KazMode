# round-display —— 每轮注入显示插件（Kaz 模式附属）

> **作用**：记录并展示每一轮 Kaz 联动/附属插件（thinking-anchor / kaz-memory /
> first-round-hints / kaz-system-prompt 等）给模型注入了什么信息，也展示
> round-minimal 上报的本轮工具面增删明细，方便你看到模型"额外看到了什么"以及工具面怎么变。

只负责「显示」，不向模型注入任何内容：记录每一轮开始时 Kaz 模式联动/附属插件
（thinking-anchor / round-minimal / kaz-memory / kaz-system-prompt 等）给模型发送的
信息，并在对话输入区右侧提供「本轮注入」按钮与面板，按下后在对话框右侧显示
本轮注入信息（格式：[插件名]>（信息内容）<）。

## 原理

- **轮次**：每次用户发一条消息 = 一轮（会话日志中最近一个 turn/start 的 data.turn）。
- **主动上报**：发布 `roundDisplay` 服务（`report({ agent, plugin, title, content })`），
  其它要发送信息的插件在发送时调用它告诉本插件要显示（best-effort：服务不存在
  时静默跳过）。2026-08-21 起不再监听组装段（thinking-anchor / kaz-memory 已改为
  消息注入，且 Kaz 模式会滤掉非 persona 段），展示内容全部来自主动上报。
- **面板通道**：专用 RPC（`/round-display`，loopback）。客户端面板打开时每 2 秒轮询：
  `list` = 当前轮；`history` = 全部轮次。
- **持久化（2026-08-21）**：记录按 agent × 轮次落盘到
  `<DSH_HOME>/storages/round-display-records.json`（`config.recordsStore` 可覆盖），
  **dsh 重启后 history 仍能看到此前各轮的注入记录**；每个 agent 最多保留
  200 轮，防抖 1s 落盘、卸载时 flush。

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
