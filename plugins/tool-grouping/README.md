# tool-grouping —— dsh 工具分组（realm）插件

对 dsh 的工具进行重新分组，把它们分配到指定的运行环境（realm）或组中，以实现更好的权限隔离与资源管理。默认将文件类工具归入 **tool-fs** 组、将工作流引擎类工具归入 **workflowEngine** 组、将 kaz-memory 记忆工具归入 **kaz-memory** 组，其余工具保持默认分组，完全不影响工具之间的正常调用。

## 功能说明

| 组（id） | realm（运行环境） | 成员工具 | 说明 |
| --- | --- | --- | --- |
| `tool-fs` | `minimal-local-fs` | `read`、`write`、`edit`、`glob`、`grep`、`str_replace_editor` | 文件读写与编辑工具，与 `str_replace_editor` 归入同一组 |
| `workflowEngine` | `workflowEngine` | `workflow`、`ralph` | 工作流引擎工具，与 `workflow-worker-thread`（工作引擎，服务提供者）同组，与默认环境隔离 |
| `kaz-memory` | `kazMemory` | `memory_save`、`memory_list`、`memory_search`、`memory_forget` | kaz-memory 记忆四工具（供 kaz-mode 白名单按组放行） |
| 默认组 | （无） | 其余所有工具 | 不参与分组，行为与未安装插件时完全一致 |

插件在 **dsh 加载工具列表的早期阶段**生效：

1. 给真实的 `tools` 注册表（`ToolRuntime`）的 `register` 打补丁——每个工具注册的瞬间即被记录归属；
2. 对注册早于本插件的工具做全量扫描补记；
3. 监听 `tools/change` 与 `loader/entry-init` 事件追记迟到的注册。

因此任意时刻查询分组视图，都能拿到完整结果；`enabled: false` 可随时整体停用。

### 工作原理与"realm"的语义（重要）

dsh 的 `tools` 注册表**没有原生的"工具 realm"概念**。`realm`（隔离环境）在 dsh 中是**组合层**（cordis.yml / cordis.patch.yml 的 `isolate` 组）针对**服务实例**的隔离域；工具只是注册进分层注册表（全局层 + 各 agent scope 层）的定义。

因此本插件把"组 / realm"实现为**运行时分组模型**（工具名 → 组，随配置热重载），并附带三件事：

- **非破坏性**：默认 `mode: tag` 完全不介入调用链——同组工具之间、跨组工具之间都遵循 dsh 默认规则；`trace` 模式也只记录不阻断；
- **可观测**：加载日志与只读状态工具 `tool_grouping_status` 输出完整分组视图；
- **组合层校验**：报告会给出组合层的真实情况——`workflowEngine` 服务是否由 agent preset 的 `isolate` realm 提供（与默认环境隔离的证据）、`tool-fs` 等组合行的挂载状态、以及带 `isolate` 的组合组结构。

> 若需要**进程级的硬隔离**（服务实例级别的权限/资源隔离），请结合 README 末尾的「组合层加固」一节，把工具插件行移入带 `isolate` 的组合组——运行时分组模型负责视图与校验，组合层负责真正的隔离。

## 对外服务：`toolGrouping`（供 kaz-mode 等消费）

本插件把**运行时分组结果**发布为 Cordis 服务 `toolGrouping`，分组事实的唯一权威来源是本插件的运行时视图；消费方（如 `kaz-mode`）只读服务、不内置任何工具列表：

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `enabled()` | boolean | 当前是否启用分组（`enabled=false` 时返回 `false`） |
| `groups()` | `{ id, realm, tools[] }[]` | 当前生效的完整分组定义（settings 热重载后即时反映） |
| `groupOf(toolName)` | `{ groupId, realm } \| null` | 查询单个工具的归属组；未分组或已禁用时返回 `null` |
| `isRegistered(toolName)` | boolean | 该工具是否已被观察到注册 |

消费示例（Cordis 插件内）：

```js
const toolGrouping = ctx.get("toolGrouping"); // 可选依赖，缺失时降级
if (toolGrouping?.enabled() === true) {
  for (const group of toolGrouping.groups()) {
    ctx.logger.info(`组 ${group.id}（realm: ${group.realm}）: ${group.tools.join(", ")}`);
  }
}
```

## 目录结构

```
tool-grouping/
├── package.json      # npm 包描述（type: module，peerDependencies 对齐 dsh 现有插件）
├── lib/
│   └── index.js      # 插件主体（Cordis 插件，默认导出）
└── README.md         # 本文档
```

## 安装步骤

### 1. 把包放进 profile 的 plugins 目录

把整个 `tool-grouping` 目录复制到 `%USERPROFILE%\.dsh\profiles\web\plugins\` 下：

```powershell
Copy-Item ".\tool-grouping" "$env:USERPROFILE\.dsh\profiles\web\plugins\tool-grouping" -Recurse -Force
```

### 2. 安装到 profile 的 node_modules（二选一）

**方式 A（推荐，与 thinking-anchor / tool-filter 一致，npm 一条命令）**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"

# 坑：dsh 环境会设置 npm_config_allow_scripts，npm 11 会拒绝项目内安装（EALLOWSCRIPTS）——
# 临时移除该环境变量（只影响这一次命令）
Remove-Item Env:npm_config_allow_scripts

# --legacy-peer-deps：跳过自动安装 peer 依赖（运行时会向上解析到 profiles\node_modules）
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/tool-grouping
```

装完后 `web/node_modules/tool-grouping` 会自动成为指向源目录的 junction，改源码即时生效（组合行仍要手动加，见下）。

**方式 B（不用 npm：复制 + 手动 junction）**：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\tool-grouping" -Target "$env:USERPROFILE\.dsh\profiles\web\plugins\tool-grouping"
```

### 3. 加组合行（`cordis.patch.yml`）

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，追加：

```yaml
# tool-grouping: 把文件类工具归入 tool-fs 组、工作流引擎工具归入 workflowEngine 组，
# 其余工具保持默认分组；运行时分组 + 组合层校验，非破坏性。
- insert:
    - id: tool-grouping
      name: tool-grouping
      config:
        enabled: true
```

- 想让插件对**所有** profile 生效：把 insert 放到 `%USERPROFILE%\.dsh\cordis.patch.yml`（机器级层）而非 profile 文件。
- `cordis.patch.yml` 支持热挂载（`watchUserPatches`），但**代码变更需要重启 dsh**（Node ESM 模块缓存），稳妥起见装完重启一次。

### 4. 配置（`settings.yaml`，热重载，免重启）

在 `%USERPROFILE%\.dsh\settings.yaml` 追加（不写也没关系，走内置默认值）：

```yaml
tool-grouping:
  enabled: true
  registerStatusTool: true
  mode: tag
  groups:
    - id: tool-fs
      realm: minimal-local-fs
      tools: [read, write, edit, glob, grep, str_replace_editor]
    - id: workflowEngine
      realm: workflowEngine
      tools: [workflow, ralph]
    - id: kaz-memory
      realm: kazMemory
      tools: [memory_save, memory_list, memory_search, memory_forget]
```

## 配置选项

所有配置项均可通过 `settings.yaml` 的 `tool-grouping:` 段**热重载**（改完即生效，无需重启）；`cordis.patch.yml` 组合行里的 `config` 作为 base 层，用户设置优先。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。`false` 时插件整体停用（补丁、监听、状态工具全部卸载），工具行为与未安装时完全一致 |
| `registerStatusTool` | boolean | `true` | 是否注册只读状态工具 `tool_grouping_status`（用于查看分组信息、验证生效） |
| `mode` | `"tag"` \| `"trace"` | `"tag"` | `tag`：仅分组与报告，完全不介入调用链；`trace`：额外在每次工具调用时输出 debug 级日志（含归属组/realm），仍不阻断任何调用 |
| `groups` | 数组 | 见上表 | 分组定义：`{ id, realm, tools[] }`。`id` 组名、`realm` 运行环境标签（缺省时等于 `id`）、`tools` 组内工具名列表。**未列出的工具自动留在默认组** |

### 使用示例：自定义分组

```yaml
tool-grouping:
  enabled: true
  mode: trace                      # 打开调用记录（debug 日志）
  registerStatusTool: true
  groups:
    - id: tool-fs                  # 文件工具组，与 str_replace_editor 同 realm
      realm: minimal-local-fs
      tools: [read, write, edit, glob, grep, str_replace_editor]
    - id: workflowEngine           # 工作引擎组，与 workflow-worker-thread 同 realm
      realm: workflowEngine
      tools: [workflow, ralph]
    - id: kaz-memory               # kaz-memory 记忆工具组
      realm: kazMemory
      tools: [memory_save, memory_list, memory_search, memory_forget]
    - id: network                  # 自定义组：把网络类工具也归到一起
      realm: network
      tools: [web_search]
```

## 如何验证插件已生效

### 1. 组合正确（免启动）

```powershell
dsh --profile web --dump-config
```

能看到 `tool-grouping` 行且 exit 0。若 `dsh.ps1` 被 PowerShell 执行策略拦截，用 `dsh.cmd` 或 `node "C:\Users\Kaczev\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config`。

### 2. 包可加载

```powershell
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/tool-grouping/lib/index.js').then(m=>console.log(m.default.name))"
# 期望输出：tool-grouping
```

### 3. 查看分组信息（最直接）

重启 dsh 后，在任意会话里调用工具 `tool_grouping_status`（无需参数），返回类似：

```
tool-grouping 分组状态报告
==================================================
配置: enabled=true, mode=tag, registerStatusTool=true
分组数: 2

[组] tool-fs  (realm: minimal-local-fs)
  ✓ read        （已注册，由 tool-fs 提供）
  ✓ write       （已注册，由 tool-fs 提供）
  ✓ edit        （已注册，由 tool-fs 提供）
  ✓ glob        （已注册，由 tool-fs-search 提供）
  ✓ grep        （已注册，由 tool-fs-search 提供）
  ✗ str_replace_editor  （未注册：当前组合未挂载该工具）

[组] workflowEngine  (realm: workflowEngine)
  ✓ workflow    （已注册，由 tool-workflow 提供）
  ✓ ralph       （已注册，由 tool-ralph 提供）

[默认组] 未分组工具（N 个）: ask_user_question, todo_write, ...

组合层事实:
  • workflowEngine 服务: 宿主平面不可见（由 agent preset 在 isolate realm 中提供，与默认环境隔离 ✓）
  • 组合行 tool-fs (@deepseek-ai/dsh-tool-fs): disabled, 所属组: (无)
  • 组合行 workflow-worker-thread (@deepseek-ai/dsh-workflow-worker-thread): disabled, 所属组: delegation
  • 组合行 tool-workflow (@deepseek-ai/dsh-tool-workflow): disabled, 所属组: delegation
  • 组合行 tool-ralph (@deepseek-ai/dsh-tool-ralph): disabled, 所属组: delegation
  • 组合行 tool-str-replace-editor (@deepseek-ai/dsh-tool-str-replace-editor): disabled, 所属组: (无)
  • 组合组 delegation: isolate realm = {workflowEngine}
  • 组合组 planning: isolate realm = {planMode}
  • 组合组 compaction: isolate realm = {compaction, toolResultPruner}
```

要点解读：

- **`✓` / `✗`**：组内工具是否已被插件观察到注册（`✗` 表示当前组合没有挂载该工具，例如 web 模式下 `str_replace_editor` 未在 preset 中启用——分组定义仍然生效，工具一旦注册即自动归组）；
- **`[默认组]`**：未分组的工具清单，说明"其他工具不受影响"；
- **组合层事实**：web 模式下宿主层的工具组合行显示 `disabled`（它们由 agent preset 挂载），`delegation` 组携带 `isolate: {workflowEngine}`——这就是 `workflow` / `ralph` / `workflow-worker-thread` 同处一个独立工作引擎组、与默认环境隔离的组合层证据。

### 4. 日志输出

启动日志（或改配置后热重载）会打印 `[tool-grouping] 已加载并完成分组：` 与完整报告；`mode: trace` 时每次工具调用还会输出 debug 级 `[tool-grouping] trace: 调用工具 "xxx"（组 … / realm …）`。

### 5. 开关验证

把 `settings.yaml` 的 `tool-grouping.enabled` 改为 `false`（热重载，无需重启）：

- 日志出现 `[tool-grouping] 已禁用（enabled=false），未执行任何分组。`；
- 模型工具列表中 `tool_grouping_status` 消失；
- 工具行为与未安装插件时完全一致。

改回 `true` 即恢复。

## 常见问题

**Q1：为什么 `str_replace_editor` 显示"未注册"？**
分组定义是"归属表"，插件只负责把注册过的工具归组。当前组合（例如 web 模式使用的 preset）没有挂载 `dsh-tool-str-replace-editor` 时，该工具就不会出现；一旦组合挂载它（或在 TUI 模式），插件会自动把它归入 `tool-fs` 组。

**Q2：`workflow` / `ralph` 与 `workflow-worker-thread` 真的在同一个 realm 吗？**
在标准 preset 中，`delegation` 组合组携带 `isolate: { workflowEngine: true }`，`tool-workflow`、`tool-ralph`、`workflow-worker-thread` 都在其中——它们共同提供/消费 `workflowEngine` 服务，与默认环境隔离。插件报告中的"组合层事实"会显示这一点；若你的组合把这几行放在别处，报告也会如实反映。

**Q3：插件会不会阻断跨组调用？**
不会。默认 `mode: tag` 完全不介入调用链；`mode: trace` 也只记录不阻断。分组是**非破坏性**的，同组/跨组调用一律遵循 dsh 默认规则。

**Q4：需要真正的进程级隔离怎么办？**
把相关工具插件行移入带 `isolate` 的组合组即可（示例见下节）。运行时分组模型负责视图与校验，组合层负责硬隔离，二者互补。

**Q5：与 tool-filter / thinking-anchor 冲突吗？**
不冲突。本插件只读取注册表与 loader 信息，不修改工具定义、不过滤、不注入 prompt；三个插件可共存（本工作区即如此）。

## 组合层加固（可选）

若要给 `tool-fs` 组加上**进程级的服务隔离**，在 `cordis.patch.yml` 中用组包裹相应插件行（注意：web 模式下这些行由 agent preset 提供，加固应作用于 preset 副本，规则见「editing-cordis-compositions」技能——preset 行发布服务时必须在带 `isolate` 的组内，消费方也须同组）：

```yaml
# 示例：把文件工具放进带 isolate 的组合组（仅示意，具体行 id 以你的组合为准）
- insert:
    - id: tool-fs-realm
      name: cordis:group
      group: true
      isolate:
        toolFs: true
      config:
        - id: tool-fs
          name: '@deepseek-ai/dsh-tool-fs'
        - id: tool-fs-search
          name: '@deepseek-ai/dsh-tool-fs-search'
        - id: tool-str-replace-editor
          name: '@deepseek-ai/dsh-tool-str-replace-editor'
```

> 注意：工具本身注册进宿主 `tools` 注册表（不发布服务），把它们放入 isolate 组主要影响的是其依赖的服务实例范围；对工具行而言，隔离的收益取决于它们消费的服务。改动组合前请先阅读工作区内的 `创建dsh插件指南.md`。
