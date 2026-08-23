# thinking-anchor（消息注入模式）

> **作用**：在每段新对话里注入"推理协议"——提醒模型保持 "We need… / We should…" 思维链、用英语思考，对抗长对话里的思维漂移。

一个 dsh（DeepSeek Harness）插件：把推理协议（We need / We should 思维链习惯）
注入每一段**新对话**。2026-08 重构后为**消息注入模式**（kaz-memory 自动载入同款
机制）——不再往 system prompt 里追加提示段（Kaz 模式的系统提示词被 kaz-mode 固定为
一句，任何提示段都会被过滤）：

- **新对话开始时**（首个 `agent/pre-step`，step === 1）把完整指令作为一条
  **合成用户消息**注入（`source.kind = "plugin"`，不触碰系统提示词）；
- **此后每个 turn 的开头**（step === 1）注入短提醒（`turnReminder`），维持
  We need / We should 思维链习惯，对抗长对话漂移；
- **续接对话**（会话日志里已有 user/message）不重复完整指令，从当轮起只提醒；
- 插件加载时已存活的 agent 被预标记——它们的对话开始于插件之前，不会收到完整指令。

两条消息都使用统一信封格式：`[thinking-anchor …] / > / 内容 / <`。
settings 里 `instruction` / `turnReminder` 字段**留空 = 使用 index.js 内置默认文案**；
关闭整个插件用 `enabled: false`。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
thinking-anchor:
  enabled: true
  instruction: ""    # 完整指令（留空 = 内置默认）
  turnReminder: ""   # 每轮提醒（留空 = 内置默认）
```

> 纯方案 A：Kaz 模式下生效配置由 kazMode 服务按会话读取（kaz-defaults.json +
> kaz-session-states.json），settings.yaml 段不再被 kaz-mode 改写、也不再自动补写。

## Kaz 联动

Kaz 模式把 thinking-anchor 作为被管理插件：生效 enabled / 文案按会话经 kazMode
服务读取（Kaz 面板可调），settings.yaml 仅作 standalone 兜底。注入是消息、不是
系统提示词，因此与 Kaz 模式的"系统提示词由 kaz-system-prompt.mjs 控制"不冲突。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`thinking-anchor` 行（config: `enabled: true`）。改完**重启 dsh + 强刷页面**。

## 验收要点

1. 新对话开头出现一条 `[thinking-anchor …]` 合成用户消息（完整协议）；
2. 此后每个 turn 开头出现短提醒；续接对话只有提醒、没有完整指令；
3. 系统提示词不受影响（Kaz 模式下由 `kaz-system-prompt.mjs` 按条件收敛）。
