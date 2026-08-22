# deepseek-default-model — DeepSeek 模型默认采样参数插件

> **作用**：管理 DeepSeek 的 generation_kwargs（temperature / top_p / repetition_penalty），面板可调——把 temperature 应用到每次请求。默认模型与思考强度（provider / model / reasoningEffort）由 DSH 官方面板管理，本插件不再持有。

控制 DeepSeek 的采样参数，并放到 Kaz 面板里随时调整。出厂默认如下
（Kaz 会话下经 Kaz 面板 / kazMode 服务生效，settings.yaml 仅 standalone 兜底）：

```yaml
deepseek-default-model:
  enabled: true
  generation_kwargs:
    temperature: 0.2
    top_p: 0.9
    repetition_penalty: 1.2
```

## 它做了什么

1. **面板管理**：作为 Kaz 模式的被管理插件，在 Kaz 面板出现一行
   （DeepSeek 采样参数），展开可调整 `temperature / top_p / repetition_penalty`。
   纯方案 A：改动按会话写入 `kaz-defaults.json` / `kaz-session-states.json`，
   **不写 settings.yaml**。
2. **temperature 应用到请求**：通过 `agent/request` 瀑布把
   `generation_kwargs.temperature` 写入每次模型请求（主会话与子代理都生效，
   按会话生效配置读取）。面板改 temperature 后，下一次请求即用新值（立即生效）。
3. **官方值 / Kaz 默认值一键切换**：Kaz 面板展开该插件后有两个按钮——
   “使用官方值（1 / 1 / 1）”把 `generation_kwargs` 设为
   `temperature=1, top_p=1, repetition_penalty=1`；“使用 Kaz 模式的默认值
   （0.2 / 0.9 / 1.2）”恢复为本插件出厂默认。
4. **关闭时恢复**：把 `enabled` 设为 `false` 后，`agent/request` 不再写入或
   删除 temperature（未显式设置时由 DeepSeek 官方默认 `temperature=1` 生效）。
   默认模型 / 思考强度不受本插件影响，始终由 DSH 官方面板负责。

## 已知限制（如实说明）

DSH 的请求管线（`GenerateOptions`）只支持 `temperature / maxTokens / stop`。
`top_p` 与 `repetition_penalty` 会保存在设置与面板中（保持与示例配置形状一致），
但当前版本的 DSH 不会把它们转发给 DeepSeek API —— 它们目前只是"预留旋钮"。

另外，默认模型（provider / model / reasoningEffort）的语义是"对之后新建会话生效"，
请在 DSH 官方面板 / `agent-default-model:` 设置段调整；本插件不再同步该段。

## 安装（本 profile）

1. 本插件位于 `KazPlugins/deepseek-default-model`。
2. `profiles/web/package.json` 已加入 `"deepseek-default-model": "file:KazPlugins/deepseek-default-model"`。
3. `profiles/web/cordis.patch.yml` 已加入插件行：
   ```yaml
   - insert:
       - id: deepseek-default-model
         name: deepseek-default-model
   ```
4. 让 node 能解析到该包：`npm install` 会把 `node_modules/deepseek-default-model`
   建成指向 `KazPlugins/deepseek-default-model` 的 junction，改源码即时生效。
5. 重启 `dsh web`（或热重载生效后刷新页面），Kaz 面板即出现该插件行。

## 卸载

1. 删除 `profiles/web/cordis.patch.yml` 中的插件行。
2. 从 `profiles/web/package.json` 移除依赖并运行 `npm install`。
3. 删除 `KazPlugins/deepseek-default-model` 目录与 `node_modules/deepseek-default-model`。
4. 可选：旧版本若在官方 `agent-default-model:` 段写过默认模型，这些值现在由
   DSH 官方面板接管，按需手动调整即可。
