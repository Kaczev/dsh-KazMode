# code-collapse —— 工具面折叠为 run_code + 每次调用后追加 We need 提示

启动后，每个会话的工具面被折叠成**唯一入口 `run_code`**（dsh 内置 Code Mode 呈现，
`presentAs('code')`）：模型只直接调用 `run_code`，其它工具以生成的 TypeScript SDK
函数形式出现在 `tools:sdk` 提示段里（这就是「附带给模型可以调用工具的提示」）。
同时，每次 `run_code` 调用完成后，插件向对话追加一条 **We need 推理风格提醒**
（双语信封，默认文案可配）——在工具调用之后、下一条用户消息之前，模型上下文里
始终带着这条提醒，避免退回 `Let me` 思维链（thinking-anchor 的系统提示只在组装时
出现，工具调用之间的步骤没有）。

## 与现有组件的分工

- **tool-grouping / round-minimal / kaz-mode**：继续负责工具集的过滤与分组；
- **code-collapse**：在工具面稳定后把最终可见面折叠成 `run_code`。因为 dsh 的
  collapse 发生在注册表/提供器层面（早于组装过滤），所以 kaz-mode / round-minimal
  各自加了「非首轮保留 run_code」的例外（首轮极简仍不暴露任何工具）。
- 折叠后 SDK 里列出的是**注册表可见工具**（tool-filter 移除的不出现）；kaz-mode
  白名单继续在执行层拒绝白名单外调用（与折叠前一致）。

## settings（`~/.dsh/settings.yaml`，热重载）

```yaml
code-collapse:
  enabled: true          # 总开关（默认开）
  appendCallHint: true   # 每次 run_code 调用后追加 We need 提示（默认开）
  # callHint 省略 = 内置默认（[code-collapse] 双语信封）
  firstRoundHint: true   # 首轮注入 run_code 使用提醒（默认开；Kaz 模式默认启用）
  # firstRoundText 省略 = 内置默认（[code-collapse First Round] We need 信封）
```

Kaz 模式把它作为第 5 个被管理插件：Kaz 面板里有它的配置行（enabled /
appendCallHint / callHint / firstRoundHint / firstRoundText 开关与文本），Kaz 模式默认启用、可单独关掉。
独立使用时：`cordis.patch.yml` 加行 + settings 控制，与其它 kaz 插件同一套路。

## 安装（与其它插件一致）

```powershell
Copy-Item ".\code-collapse" "$env:USERPROFILE\.dsh\profiles\web\plugins\code-collapse" -Recurse -Force
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/code-collapse
```

cordis.patch.yml 追加：

```yaml
- insert:
    - id: code-collapse
      name: code-collapse
      config:
        enabled: true
```

改完重启 dsh + 强刷页面（代码改动必须重启）。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\plugins\code-collapse\probe-code-collapse.mjs"
```

## 验收要点

1. 新会话第二轮起，模型可见工具只剩 `run_code` + SDK 提示（`tools:code-only` /
   `tools:sdk` 两段）。
2. 首轮注入 `code-collapse:first-round` 段（[标题] / > / 内容 / <，We need 风格）：
   提醒模型尽量用一次 `run_code` 调用多个工具；`firstRoundHint=false` 关闭、
   `firstRoundText` 自定义文案。
3. 每次 `run_code` 调用后，对话历史追加一条 `[code-collapse]` 双语 We need 提示。
4. Kaz 面板的 code-collapse 配置行：关闭 `enabled` 后新会话恢复原生工具面；
   关闭 `appendCallHint` 后不再追加提示；改 `callHint` 后提示文本变化。
4. 独立使用（不开 Kaz）同样生效。

> **部署白名单注意**：面板经 api 网关 settings 通道读写 `code-collapse` 命名空间，
> 网关白名单（`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`）需加入
> `code-collapse`（升级 dsh 会覆盖本地补丁，需重新加回）。
