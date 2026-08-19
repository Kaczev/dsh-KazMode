# deepseek-default-model — DeepSeek 模型默认参数插件

控制 DeepSeek 模型默认参数，并放到 Kaz 面板里随时调整。默认参数如下：

```yaml
deepseek-default-model:
  enabled: true
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
  generation_kwargs:
    temperature: 0.2
    top_p: 1
    repetition_penalty: 1.2
```

## 它做了什么

1. **面板管理**：作为 Kaz 模式的第 9 个被管理插件，在 Kaz 面板出现一行
   （DeepSeek 默认参数），展开可调整 `provider / model / reasoningEffort /
   temperature / top_p / repetition_penalty`。改动自动写入
   `~/.dsh/settings.yaml` 的 `deepseek-default-model:` 段，热重载。
2. **同步官方默认模型**：面板里的 `provider / model / reasoningEffort`
   会同步进官方 `agent-default-model:` 设置段（`dsh-agent-default-model`
   服务读取它决定**新会话**的默认模型选择），因此改默认模型/思考强度后，
   新建会话立即生效。
3. **temperature 应用到请求**：通过 `agent/request` 瀑布把
   `generation_kwargs.temperature` 写入每次模型请求（主会话与子代理都生效）。
   面板改 temperature 后，下一次请求即用新值（立即生效）。
4. **设置文件自愈**：
   - `settings.yaml` 缺失时由 settings 服务首次写入自动创建；本插件段缺失键
     自动补齐默认值（只补缺失，保留已有配置）。
   - 官方 `agent-default-model:` 段缺失 `provider/model/reasoningEffort` 时只补
     缺失键。
   - `cordis.patch.yml` 随插件包发布（bundle patch，供以 bundle 方式安装到其它
     profile 时自动注册）；本 profile 的行已写入 `profiles/web/cordis.patch.yml`。

## 已知限制（如实说明）

DSH 的请求管线（`GenerateOptions`）只支持 `temperature / maxTokens / stop`。
`top_p` 与 `repetition_penalty` 会保存在设置与面板中（保持与示例配置形状一致），
但当前版本的 DSH 不会把它们转发给 DeepSeek API —— 它们目前只是"预留旋钮"。

另外，DSH 的默认模型语义是"对之后新建会话生效"：已开始的会话沿用其创建时的
选择（官方 `agent-default-model` 同样如此），temperature 例外——它按请求读取，
面板改动下一次请求即生效。

## 安装（本 profile）

1. 本插件位于 `profiles/web/plugins/deepseek-default-model`。
2. `profiles/web/package.json` 已加入 `"deepseek-default-model": "file:plugins/deepseek-default-model"`。
3. `profiles/web/cordis.patch.yml` 已加入插件行：
   ```yaml
   - insert:
       - id: deepseek-default-model
         name: deepseek-default-model
   ```
4. 让 node 能解析到该包：本插件安装时已创建
   `profiles/web/node_modules/deepseek-default-model/package.json` 解析桩
   （`main` 指向 `../../plugins/deepseek-default-model/lib/index.js`），**无需安装即可用**。
   若之后想用包管理器正式管理（会生成 junction），先删除该桩目录，再在
   `profiles/web` 下运行：
   ```
   npm.cmd install --legacy-peer-deps --no-audit --no-fund
   ```
   （本工作区其它插件均以 `file:plugins/...` + junction 方式管理。）
5. 重启 `dsh web`（或热重载生效后刷新页面），Kaz 面板即出现该插件行。

## 卸载

1. 删除 `profiles/web/cordis.patch.yml` 中的插件行。
2. 从 `profiles/web/package.json` 移除依赖并运行 `pnpm install`。
3. 删除 `plugins/deepseek-default-model` 目录与 `node_modules/deepseek-default-model`。
4. 可选：删除 `settings.yaml` 中的 `deepseek-default-model:` 段（官方
   `agent-default-model:` 段会保留你最后设置的值，属正常行为）。
