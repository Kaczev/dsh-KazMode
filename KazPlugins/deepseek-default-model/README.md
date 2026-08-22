# deepseek-default-model — DeepSeek 模型默认参数插件

> **作用**：管理 DeepSeek 默认模型参数（provider / model / reasoningEffort / temperature 等），面板可调——同步官方"新会话默认模型"并把 temperature 应用到每次请求。

控制 DeepSeek 模型默认参数，并放到 Kaz 面板里随时调整。出厂默认如下
（Kaz 会话下经 Kaz 面板 / kazMode 服务生效，settings.yaml 仅 standalone 兜底）：

```yaml
deepseek-default-model:
  enabled: true
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
  generation_kwargs:
    temperature: 0.2
    top_p: 0.9
    repetition_penalty: 1.2
```

## 它做了什么

1. **面板管理**：作为 Kaz 模式的被管理插件，在 Kaz 面板出现一行
   （DeepSeek 默认参数），展开可调整 `provider / model / reasoningEffort /
   temperature / top_p / repetition_penalty`。纯方案 A：改动按会话写入
   `kaz-defaults.json` / `kaz-session-states.json`，**不写 settings.yaml**。
2. **同步官方默认模型**：面板里的 `provider / model / reasoningEffort`
   会同步进官方 `agent-default-model:` 设置段（`dsh-agent-default-model`
   服务读取它决定**新会话**的默认模型选择），因此改默认模型/思考强度后，
   新建会话立即生效。
3. **temperature 应用到请求**：通过 `agent/request` 瀑布把
   `generation_kwargs.temperature` 写入每次模型请求（主会话与子代理都生效，
   按会话生效配置读取）。面板改 temperature 后，下一次请求即用新值（立即生效）。
4. **官方值 / Kaz 默认值一键切换**：Kaz 面板展开该插件后有两个按钮——
   “使用官方值（1 / 1 / 1）”把 `generation_kwargs` 设为
   `temperature=1, top_p=1, repetition_penalty=1`；“使用 Kaz 模式的默认值
   （0.2 / 0.9 / 1.2）”恢复为本插件出厂默认。
5. **关闭时恢复**：把 `enabled` 设为 `false` 后，`agent/request` 不再写入或
   删除 temperature（未显式设置时由 DeepSeek 官方默认 `temperature=1` 生效），
   并会把官方 `agent-default-model:` 段里**本插件写过的键**恢复到默认值
   （只还原本插件写过的键，其余键保留）。
6. **官方段自愈**：官方 `agent-default-model:` 段缺失
   `provider/model/reasoningEffort` 时只补缺失键。（本插件自身 settings 段的
   自愈写入已在纯方案 A 关闭——settings.yaml 不再自动补写。）

## 已知限制（如实说明）

DSH 的请求管线（`GenerateOptions`）只支持 `temperature / maxTokens / stop`。
`top_p` 与 `repetition_penalty` 会保存在设置与面板中（保持与示例配置形状一致），
但当前版本的 DSH 不会把它们转发给 DeepSeek API —— 它们目前只是"预留旋钮"。

另外，DSH 的默认模型语义是"对之后新建会话生效"：已开始的会话沿用其创建时的
选择（官方 `agent-default-model` 同样如此），temperature 例外——它按请求读取，
面板改动下一次请求即生效。

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
4. 可选：插件关闭时已恢复过官方 `agent-default-model:` 段中本插件写过的键；
   若仍有残留，可手动把该段改回 `provider: deepseek-official` /
   `model: deepseek-v4-flash`。
