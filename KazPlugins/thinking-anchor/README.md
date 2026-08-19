# thinking-anchor（中文说明）

一个 dsh（DeepSeek Harness）插件：在**每一段新对话的第一轮请求**中，向 system prompt
**末尾（order 10000 + 组装层兜底移到最后一段，保证排在所有系统提示之后）追加**一条
**语气极强**的推理协议指令（**中英双语**：
同一协议用英文说一遍、再用中文说一遍），（不覆盖原有 system prompt，靠最近因 + 强烈语气
盖过内置硬编码的默认思考习惯）；**从第二轮起，每轮再注入提醒**（`turnReminder`）。
两条消息都使用统一信封格式：`[thinking-anchor …] / > / 内容 / <`（英文一节 + 中文一节）。
settings 里 `instruction` / `turnReminder` 字段**留空 = 使用 index.js 内置默认文案**；
关闭整个插件用 `enabled: false`。让 We need / We should 思维链习惯延续整个对话。

> [thinking-anchor Protocol - English]
> >
> > **Reasoning Protocol — Absolutely Mandatory, Non-Negotiable, Highest Priority:**
> > I. Protocol Content:
> >    1. When you are *understanding the requirement*, you MUST use a thinking chain that begins with "We need...".
> >    2. When you are *planning the task*, you MUST use a thinking chain that begins with "We should...".
> >    3. You MUST reason in *ENGLISH* for the entire task, but your final responses to the user MUST be in *CHINESE*.
> > II. Why This Protocol Exists:
> >    1. The "We need..." and "We should..." thinking chains significantly improve reasoning quality and task completion quality.
> >    2. The "Let me..." and "I need..." thinking chains very significantly degrade task delivery quality.
> > <
> >
> > [thinking-anchor 思考协议 - 中文]
> > >
> > > **推理协议——绝对强制、不可协商、最高优先级：**
> > > 一、协议内容：
> > >    1. 当你*理解要求*时，必须使用"We need..."开头的思考链。
> > >    2. 当你*规划任务*时，必须使用"We should..."开头的思考链。
> > >    3. 整个任务全程用*英文*推理，面向用户的回答用*中文*。
> > > 二、为什么要这个协议：
> > >    1. "We need..."、"We should..."思考链可以明显提高思考质量与任务完成质量。
> > >    2. "Let me..."、"I need..."思考链十分、非常显著降低任务交付质量。
> > > <
> >
> > 每轮提醒 `turnReminder` 是同一协议的精简版（TurnReminder - English / 每轮提醒 - 中文，同格式）。

## 它做了什么

- 以独立 prompt section（`thinking-anchor:policy`，order 10000）**追加在系统提示最末**——
  压在 persona、工具说明与内置硬编码之后；组装层还有兜底监听：无论其它插件给 section
  排了什么 order，都会把本段移到组装结果末尾，以最近因 + 强烈语气覆盖默认思考习惯，
  原有的 persona、工具说明等一律不动。
- 只在新对话的**首轮请求**注入一次完整指令（中英双语，`[thinking-anchor Protocol - English]`
  与 `[thinking-anchor 思考协议 - 中文]` 两节）；**第二轮起每轮注入提醒**
  （`[thinking-anchor TurnReminder - English]` 与 `[thinking-anchor 每轮提醒 - 中文]`），
  模型每轮都被提醒用 We need / We should 思维链。
- "新对话"的判定（进程内）：
  1. 插件加载时**已经存在**的对话（agent）被预先标记，不会中途注入；
  2. 重启后**续接的旧对话**（日志里已有用户消息）也跳过；
  3. 只有插件加载后**新开始**的对话在首轮注入。
- 开关和指令文本都配置在 `~/.dsh/settings.yaml`，**都是热重载**——改完保存即生效（改
   `enabled` 或改 `instruction` 都不需要重启）：
  ```yaml
  thinking-anchor:
    instruction: ""      # 首轮消息：留空 = 用 index.js 内置默认文案
    turnReminder: ""     # 每轮提醒：留空 = 用内置默认；关闭整个插件用 enabled: false
  ```

## 文件结构

```
thinking-anchor/
├── package.json      # 包元数据 + peer 依赖
├── lib/index.js      # 插件本体（纯 ESM，Cordis 插件）
└── README.zh-CN.md   # 本文件
```

## 安装

> 如果你用的是本机已装好的这份（npm 方式已装好，见 `~/.dsh/profiles/web/package.json`
> 的 `dependencies`），直接跳到「使用」。

dsh 的插件 = 一个 npm 包 + 组合（`cordis.yml` 补丁）里的一行。**npm 命令负责把包装进
profile**；`cordis.patch.yml` 那一行仍然要手动加（dsh 只加载组合里声明的插件，npm 管不到
这一步）。共三步：

**① 用 npm 安装包**（在 `~/.dsh/profiles/web` 目录下）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"

# 本机 dsh 环境会设置 npm_config_allow_scripts，npm 11 会因此拒绝项目内安装，
# 临时移除即可（只影响这一次命令，不持久化）
Remove-Item Env:npm_config_allow_scripts

# 把包装进 profile 的 node_modules（--legacy-peer-deps：跳过自动安装 peer 依赖，
# 运行时会向上解析到 profiles\node_modules 里已有的 @deepseek-ai/*）
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/thinking-anchor
```

`./plugins/thinking-anchor` 换成你的包路径（绝对路径、相对路径都行）。装完后
`web/package.json` 的 `dependencies` 里会出现 `"thinking-anchor": "file:plugins/thinking-anchor"`。
npm 的 `file:` 依赖在 Windows 上是目录联接（junction），所以以后直接改
`web/plugins/thinking-anchor/` 里的源码即生效，不需要重装。

> 没有 npm / 不想用 npm 的替代法：把包复制到 `~/.dsh/profiles/web/plugins/thinking-anchor`，
> 再建一条 junction：`New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\thinking-anchor" -Target <包目录>`。

**② 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加组合行**：

```yaml
- insert:
    - id: thinking-anchor
      name: thinking-anchor
      config:
        enabled: true
```

想对所有 profile 生效：把这段放到 `~/.dsh/cordis.patch.yml`（机器级层）而不是 profile 文件。

**③ 在 `~/.dsh/settings.yaml` 里加开关**（可省，默认开启；加上便于日后关闭）：

```yaml
thinking-anchor:
  enabled: true
```

**④ 重启 dsh**。运行中的 dsh 其实会热重载用户补丁（改完 cordis.patch.yml 可能当场生效），
但重启可以确保挂载状态干净。

> 另外：官方还有 `dsh plugin --profile web add <包名>` 命令，但它需要 pnpm 且会把插件当
> bundle 层处理；本机没装 pnpm，所以上面用 npm 方式。

## 使用

- **无需任何操作**：插件加载后，新开一段对话即自动生效；同一段对话后续轮次不会重复注入。
- **关闭插件**：把 `~/.dsh/settings.yaml` 里 `thinking-anchor.enabled` 改成 `false`，保存即可
  （热重载，不用重启）；想彻底移除再删掉组合行和依赖。
- **开启**：改回 `true` 保存。
- **修改指令措辞 / 每轮提醒**：直接改 `thinking-anchor.instruction` / `thinking-anchor.turnReminder`
  后保存即可，**热重载，不用重启**。两个字段**留空 = 使用 index.js 里的内置默认文案**
  （内置文案是权威来源，改文案直接改 index.js 的 `DEFAULT_INSTRUCTION` / `DEFAULT_TURN_REMINDER`，
  代码改动需要重启 dsh 一次）；**关闭整个插件**：`enabled: false`。
- 在设置页（设置 → 插件配置）里也能看到 `thinking-anchor` 命名空间及其 `enabled` 开关
  和 `instruction` 文本框。

## 如何验证生效

1. **组合正确**（免启动，不用重启）：

   ```powershell
   dsh --profile web --dump-config | Select-String "thinking-anchor"
   ```

   输出里应能看到 `thinking-anchor` 行。

2. **真实新对话**：新开一段对话，问模型：

   > 你被要求怎么思考？逐字引用 system prompt 里关于英文推理、或以 "We need..." 开头的那句指令。

   模型应逐字复述这条指令；发第二条消息后，system prompt 里应出现 `turnReminder`
   提醒文本（此后每轮都出现，直到对话结束）。

3. **开关**：把 `enabled` 改成 `false` 保存，再新开一段对话重复第 2 步 —— 应不再出现该指令；
   验证完改回 `true`。

4. **旧对话不受影响**：插件加载前已开始的对话永远不会收到该指令，只有新对话会。

## 设计说明 / 注意事项

- section 注册在 host 平面，因此**子代理也算一段新对话**，同样只注入一次；若只想作用于主对话，
  可以在 provider 里按 `agent.id` 过滤。
- 重启后接续的旧对话（日志已有用户消息）不再注入完整指令，但从当轮起每轮照常提醒。
- 进程内 anchored 记录很小（每段对话一个条目），agent 销毁时自动清理。
- 本插件与 `@deepseek-ai/dsh-base` 的 `system-prompt`、`settings` 行配套；若组合里移除了
  `system-prompt` 行，插件会等待该服务出现。

## 卸载

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm uninstall --legacy-peer-deps thinking-anchor
# 再删掉 cordis.patch.yml 里的 insert 行和 settings.yaml 里的 thinking-anchor: 段，重启 dsh
```
