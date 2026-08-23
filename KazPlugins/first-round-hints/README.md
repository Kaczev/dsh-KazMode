# first-round-hints —— 首轮其它消息提示插件

> **作用**：对话开始时注入一条"使用要点"消息（pwsh 输出是对象别拼串、别用 Get-Content 读 UTF-8、JSON 陷阱、EIO 重试、该问就问、别乱搜网等），让模型一开场就避开常见坑。

对话开始时（首个 `agent/pre-step`，step === 1）把一条固定消息**注入一次**
（kaz-memory 自动载入 / thinking-anchor 同款机制）：以**合成用户消息**追加到
当前请求，不触碰系统提示词（Kaz 模式的系统提示词由 kaz 预设的
`kaz-system-prompt.mjs` 控制）。

## 默认消息（内置四段：pwsh 要点 / EIO 重试 / 提问 / 搜索）

```text
[first-round-hints pwsh quick rules]
>
- pwsh result: stdout/stderr are OBJECTS, not strings — read .text (r.stdout?.text ?? ""), never concatenate them directly.
- Encoding: do not read UTF-8 files with Get-Content (CJK becomes mojibake) — use the read tool.
- PowerShell JSON: ConvertTo-Json flattens single-element arrays to a bare string (use -AsArray or build the JSON manually); Set-Content -Encoding UTF8 adds a BOM that breaks JSON.parse (strip /^\uFEFF/ or write with node).
<
[first-round-hints EIO]
>
- If write/edit reports 'Error: ReplaceFileW EIO (Win32 1175)', retry the exact same edit once — it is an intermittent Windows FS error.
<
[first-round-hints ask]
>
- We need to ask the user for clarification when the task goal or context is ambiguous.
- we need to ask the user to resolve conflicts when multiple requirements cannot be satisfied simultaneously.
<
[first-round-hints web_search]
>
- We should avoid web_search when we have sufficient information.
<
```

（run_code 要点已按 Kaczev 要求移除。）

## 注入策略

- **每会话一次**：新对话开始时的首个 step 注入；之后不再重复；
- **续接对话不注入**：会话日志里已有 user/message（重启后恢复的旧对话）跳过；
- **插件加载时已存活的 agent 预标记**：它们的对话开始于插件之前，不注入；
- `enabled: false` 关闭整个插件。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
first-round-hints:
  enabled: true    # 总开关（默认开）
  message: ""      # 注入的消息内容（留空 = 内置默认四段）
```

> 纯方案 A：Kaz 模式下生效配置由 kazMode 服务按会话读取，settings.yaml 段不再被
> kaz-mode 改写、也不再自动补写。

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`first-round-hints` 行（config: `enabled: true`）。改完**重启 dsh + 强刷页面**。

## 验收要点

1. 新对话开头出现一条 `[first-round-hints pwsh quick rules]` 合成用户消息；
2. 同一会话后续轮次不再重复注入；重启恢复的旧对话不注入；
3. `first-round-hints.message` 改文案后新对话按新文案注入；
4. 系统提示词不受影响（Kaz 模式下由 `kaz-system-prompt.mjs` 按条件收敛）。
