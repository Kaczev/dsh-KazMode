# kaz-memory —— 独立记忆插件（BM25 检索 + 摘要 + 自动载入 + RPC 面板通道）

> **作用**：跨会话明文记忆——模型把经验存成记忆（六工具），相同话题下越用越好用；人工确认闸门 + 自动载入 + 面板管理。

默认**不注入记忆正文**，固定记忆指引默认**关闭**（`guidanceHeadEnabled=false`）、遗忘指引默认**开启**（`guidanceForgetEnabled=true`）；需要时在 Kaz 面板调整对应开关（`guidanceHead` / `guidanceForget` 留空 = 内置默认，也可自定义）；开启后首轮工具调用后会注入记忆指引，并在后续每一轮开头重复注入；每一轮首次使用 `memory_search` 后会（默认）注入一条清理遗忘指引；对每条记忆可标记「自动载入」，在**对话开始时**自动注入一次（2026-08 重构：不再等 memory_search 首次可用）。2026-08 升级：**BM25 相关性检索（vendored okapibm25，离线可用）+ 摘要字段 + 分页 + memory_detail 分片读取**。

| kaz-memory |
| --- | --- | --- |
| 引擎 / 存储 | MemoryEngine，`$DSH_HOME/storages/memory.json`（global）+ `<cwd>/.dsh/storages/memory_project.json`（project） | **vendored 同一引擎（MIT），格式兼容**；global 存 `$DSH_HOME/storages/memory.json`，project 按**项目文件夹**各存一份 `<项目>/.dsh/storages/memory_project.json`（2026-08-17 起不再用 `process.cwd()`）。2026-08 升级：每条记录含 `name / keywords / summary / content / created_at / updated_at`（时间戳为 ISO 字符串；旧记录 `createdAt/updatedAt` 毫秒数字读取时自动迁移，写回时落新格式） |
| 工具 | memory_save / memory_update / memory_list / memory_search / memory_forget | 六个工具：`memory_save`（必填 name/keywords/content/summary）、`memory_update`（可改正文/标签/标题/摘要）、`memory_list`（只回 id/namespace/status/autoLoad/名称）、`memory_search`（**BM25 相关性排序**，返回 id/name/summary/keywords/score，**不含 content**，支持 limit/offset 分页）、`memory_detail`（**新增**：按 id 分片读取全文）、`memory_forget`；所有工具描述与参数为英文 |
| 固定指引 | tool:memory | 固定指引默认关闭（`guidanceHeadEnabled=false`）；开启后首轮工具调用后以上下文消息注入，并从下一轮起在每轮开头重复注入（`guidanceHead` 留空 = 内置默认）；每轮首次 `memory_search` 后默认注入一次遗忘指引（`guidanceForgetEnabled=true`，`guidanceForget` 留空 = 内置默认）；已确认且标记自动载入的记忆会在对话开始时自动注入一次 |
| 上下文注入 | `memory:recall` 把 applied 记忆逐条注入系统提示 | **按需注入一次**：已确认（applied）且标记「自动载入」（autoLoad）的记忆，在**对话开始**（首个 pre-step）以上下文注入方式注入一次；其余记忆靠模型主动 `memory_search` |
| 人工确认闸门 | setStatus 仅存于服务层，**无 UI / 工具 / CLI（断头路）** | 客户端半：会话头部「记忆」按钮（Kaz 按钮左侧，order -2）+ 面板（待确认：确认生效/忽略/删除；**全部记忆：点标题按需取全文 / 改名 / 删除**），经**专用 Connection RPC 通道 `/kaz-memory`（loopback）**读写——settings.yaml 不再承载任何记忆存储信息；模型没有任何对应工具 |

## 记忆结构（JSON 存储，2026-08 升级）

每条记忆在 JSON 文件里包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识（UUID） |
| `name` | string | 简短标题（保存时必填；旧记录回退从正文标题行/首行推导，≤140 字） |
| `keywords` | string[] | 关键词数组（保存时必填；供 BM25 检索的锚点词，统一小写） |
| `summary` | string | **一句话摘要（约 100 字）——由模型在 `memory_save` 时提供，插件不生成**；旧记录回退空串 |
| `content` | string | 完整的记忆正文 |
| `created_at` | string | 创建时间戳（ISO 字符串） |
| `updated_at` | string | 最后更新时间戳（ISO 字符串，更新时刷新） |

**兼容性**：旧 JSON 里的 `createdAt` / `updatedAt`（毫秒数字）读取时自动迁移为 ISO 字符串对外暴露；写回时落新格式（旧数字键不再保留）。无 `summary` 的旧记录按空串读取，`memory_update` 可补写摘要。

## 设计要点

- **BM25 检索（2026-08 升级）**：`memory_search` 对每条记忆的 `content`（主要）+ `summary` + `keywords` 实时计算 **BM25 相关性分数**（vendored [okapibm25](https://github.com/FurkanToprak/OkapiBM25)，MIT，见 `lib/okapibm25.js` 与 `LICENSE-okapibm25`——**随插件内置，安装无需联网**），按分数降序返回，支持 `limit`（默认 10，上限 100）与 `offset`（默认 0，上限 1000）分页。分数参数 `k1`（默认 1.2）、`b`（默认 0.75）在 `settings.yaml` 的 `kaz-memory.bm25` 段调整（见下「配置」），无需暴露 UI。每次搜索实时重算（记忆量 ≤1000 时性能可接受），保证结果与当前记忆库一致；**评分异步分块计算**（每 200 条让出一次事件循环），不阻塞主线程。无命中返回**空数组**（不是错误）；`query` 为空报错。
- **memory_search 只回摘要（2026-08 升级）**：命中项只含 `id / name / summary / keywords / score`，**不返回 content**；要看全文用 `memory_detail`。旧版「search 返回全文」的行为不再保留。
- **memory_detail（2026-08 新增）**：按 `id` 读取单条记忆的完整正文，支持分片：`offset`（默认 0）+ `limit`（默认 500，上限 5000）返回 `content_preview`，并给出 `total_length` 与 `has_more`（`offset + limit < total_length`）。`id` 不存在时报错；`offset` 超出正文长度时返回空串（`total_length` 提示真实长度）且 `has_more=false`。
- **memory_save 必填四件套（2026-08 升级）**：`name` / `keywords` / `content` / `summary` 全部必填（缺任一报错），`namespace` 可选（默认 global）。`summary` 由调用方（模型）提供，插件不生成。
- **name 入 JSON（2026-08-19）**：每条记录持久化 `name` 字段；面板可「改名」，改完写回 JSON。旧记录没有 `name` 时读取端按旧逻辑从正文现算（不强制迁移）。
- **自动载入（2026-08-19 引入，2026-08 重构触发时机）**：每条记忆新增 `autoLoad` 布尔字段（默认 `false`，旧记录读作 false）。面板可逐条切换「自动载入」，已确认且标记的记忆在**对话开始时**（首个 `agent/pre-step`，step === 1）以 `source: {kind:'plugin', form:'recall'}` 的用户消息**注入一次**；每个会话只注入一次。**只注入 status=applied 且 autoLoad=true 的记忆**，pending/ignored 不注入。跨重启去重（2026-08-19）："已注入"标记持久化在 `~/.dsh/storages/kaz-memory-auto-injected.json`（agent/session id 集合，仅实际注入成功后落标）；插件加载时还会预标记当前已存在的所有 agent——dsh 重启后恢复的会话不会重复注入，新会话仍正常注入一次。
- **其余记忆按需拉取**：未标记自动载入的记忆不进上下文，模型需要时主动 `memory_search` → `memory_detail`。
- **memory_list 只回名称（2026-08-16）**：`memory_list` 只返回 `id / namespace / status / autoLoad / 名称`，**不含正文与 keywords**——避免一次列表调用把记忆灌进上下文干扰当前任务。要看具体内容用 `memory_search`（摘要）或 `memory_detail`（全文）。
- **项目记忆按项目文件夹隔离（2026-08-17）**：project 记忆不再写 dsh 进程的 `process.cwd()`，而是写到 **`<项目文件夹>/.dsh/storages/memory_project.json`**。项目根从调用工具的 agent 会话 cwd（`exec.agent.session.header.cwd`）解析；配置 `projectRoot` 可显式覆盖；无 agent / 无配置时才兜底 `process.cwd()`。引擎按项目根**懒加载独立存储域**，每个项目文件夹一份 json、互不混淆。面板镜像与「项目记忆」只显示**当前会话所在项目**的那份，并标注项目路径。**只读不建目录（2026-08-17）**：读路径（list/search/镜像/detail）只在项目文件**已存在**时才打开域，否则直接返回空——只有 `memory_save` 写入才会真的创建 `<项目>/.dsh/storages`，杜绝在桌面等无关目录被读操作凭空建出 `.dsh/storages`。
- **面板项目跟随工作区（2026-08-19 改为 RPC）**：客户端（root 作用域按钮收到 `useSessions`）读取 `current` 会话的 `SessionSummary.cwd`，每次 RPC 调用都显式带上 `project` 参数；宿主据此读对应项目文件夹的记忆，无需进程内项目根上报。
- **面板桥接机制（2026-08-19 改为专用 RPC）**：宿主在 `ctx.connection.rpc` 注册 **`/kaz-memory` 通道（authority=loopback）**，提供 `list` / `open` / `rename` / `status` / `autoLoad` / `forget` / `openFolder` 端点：`list` 返回元数据（id/namespace/status/autoLoad/名称/summary/created_at/updated_at/所属项目，无正文、按 updated_at 倒序）+ 两个记忆文件夹路径；`open` 按需取正文；`rename` 把新名称写回 JSON；`status`/`autoLoad`/`forget` 对应确认/忽略/自动载入/删除；`openFolder` 打开对应记忆文件夹。**settings.yaml 不再承载任何记忆存储信息**，记忆本体始终只在明文 JSON 文件里；面板打开时拉取一次 + 每 2 秒轮询 + 手动刷新按钮。
- **打开记忆文件夹按钮（2026-08-17）**：面板顶部「打开全局记忆文件夹」「打开项目记忆文件夹」两个按钮。
- **面板不被侧边栏裁剪（2026-08-17）**：记忆面板经 `createPortal` 挂到 `document.body`，按按钮矩形 fixed 定位、自动在视口内收拢。
- **消息格式（2026-08-17 起精简；2026-08-21 改为主动行动式措辞；2026-08-22 改为首轮工具调用后注入，后续每轮开头重复；2026-08-23 固定指引默认关、遗忘指引默认开）**：记忆指引是**首轮工具调用之后以上下文消息注入、并从下一轮起在每轮开头重复**的**固定短提示**——`[kaz-memory guidance] / > / 内容 / <` 信封格式。固定指引**默认关闭**，需要先在 Kaz 面板或配置里打开 `guidanceHeadEnabled`；`guidanceHead` 留空 = 内置默认，也可自定义文本；开启后仅当 `memory_search` 在当前环境确实可调用时发送。**每一轮第一次 `memory_search` 之后**默认（`guidanceForgetEnabled=true`）以同一信封格式再注入一条**遗忘指引**（`guidanceForget` 留空 = 内置默认；可自定义），按 turn 注入、每个 turn 内只注入一次，且仅在 `memory_search` 与 `memory_forget` 都可用时发送。Kaz 模式会滤掉 systemPrompt 段，因此固定指引不再注册 `tool:memory:kaz-memory` 系统提示段，改为 `agent/pre-step` 合成用户消息注入；部署基础英文记忆指引段（`tool:memory`）仍在组装层**无条件移除**。
- **总开关（纯方案 A，2026-08-21）**：Kaz 会话下生效 enabled 由 kazMode 服务按会话
  读取（Kaz 面板开关，kaz-defaults.json + kaz-session-states.json）。关闭时（该会话
  生效 enabled=false）：六个记忆工具从该会话工具面移出、调用被拒，不注入记忆指引、
  不自动载入，客户端不渲染记忆面板；settings.yaml 的 `kaz-memory.enabled=false`
  仍作为 standalone 硬闸门（六工具完全注销、任何模式不出现）。
- **指引配置（2026-08-17；2026-08-23 加开关）**：settings.yaml `kaz-memory` 段生效字段——`guidance`（旧字段，整段覆盖）、`guidanceHeadEnabled`（固定提示总述行开关，默认关）、`guidanceHead`（固定提示总述行文本，开启后才生效；留空 = 内置默认）、`guidanceForgetEnabled`（遗忘指引开关，默认开）、`guidanceForget`（遗忘指引文本，开启后才生效；留空 = 内置默认）；`guidanceSearch` / `guidanceSave` / `guidanceList` 仍保留兼容但**不再生效**。
- **闸门（含 memory_update）**：模型 memory_save 仍然只能写 `pending`，只有人在面板点「确认生效」才会置为 `applied`；「忽略」置为 `ignored`；「删除」即 forget。`memory_update` 可修改已有记忆的正文/标签/标题/摘要；**修改 applied 记忆的正文会把它降级回 `pending`**，需人工再次确认，只改标签/标题/摘要不降级。「自动载入」开关只由面板操作（模型没有对应工具）；未确认的记忆即使勾选也不注入。
- **状态命名（2026-08 起）**：对外统一 `pending`（待确认）/ `ignored`（已忽略）/ `applied`（已生效）；旧 JSON 里的 `suggested` / `suggest` / `auto` 读取时自动映射到新值，写回时逐步落新值，无需手工迁移。

## 配置（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

`kaz-memory` 段现在只有**指引配置 + BM25 参数**（记忆数据全部在 JSON 文件里）：

```yaml
kaz-memory:
  enabled: true          # 总开关（Kaz 模式面板也提供；standalone 硬闸门）
  guidance: ""           # 旧字段：整段指引覆盖（留空 = 不启用旧覆盖）
  guidanceHeadEnabled: false  # 固定提示总述行开关（默认关；Kaz 面板提供）
  guidanceHead: ""       # 固定提示总述行文本（仅 guidanceHeadEnabled=true 时生效；留空 = 内置默认）
  guidanceForgetEnabled: true   # 遗忘指引开关（默认开；Kaz 面板提供）
  guidanceForget: ""     # 遗忘指引文本（仅 guidanceForgetEnabled=true 时生效；留空 = 内置默认）
  bm25:                  # BM25 检索参数（memory_search 评分用；Kaz 面板的 kaz-memory 行也提供 k1/b 输入）
    k1: 1.2              # 词频饱和参数（默认 1.2，一般取值 1.2 ~ 2.0）
    b: 0.75              # 长度归一化参数（默认 0.75，0 = 不做长度归一化）
```

> 纯方案 A：Kaz 会话下这些配置的生效值由 kazMode 服务按会话读取（kaz-defaults.json
> + kaz-session-states.json），settings.yaml 段仅作 standalone 兜底，**不再自动补写**。

## 存储位置（2026-08-17 起）

- **全局记忆**：`$DSH_HOME/storages/memory.json`（本机 `C:\Users\Kaczev\.dsh\storages\memory.json`）。
- **项目记忆**：每个项目文件夹一份 `<项目>/.dsh/storages/memory_project.json`。
- **时间戳格式（2026-08 升级）**：新写入/更新的记录使用 `created_at` / `updated_at`（ISO 字符串）；旧文件里的 `createdAt` / `updatedAt`（毫秒数字）读取时自动迁移、写回时落新格式。

## 安装（与其它 KazPlugins 同一套路；okapibm25 已内置，无需联网）

> **依赖 kaz-shared**：kaz-memory 依赖 `KazPlugins/kaz-shared`（Kaz 工具清单单一事实源，纯模块包）。
> 安装前请确保 `profiles/web/package.json` 里已声明 `"kaz-shared": "file:KazPlugins/kaz-shared"`（见仓库根 README），
> 且 `profiles/web/node_modules/kaz-shared` junction 存在；漏装会导致本插件无法加载。

```powershell
# 1) 复制插件到 web profile（本机实际路径是 KazPlugins）
Copy-Item ".\kaz-memory" "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-memory" -Recurse -Force

# 2) 在 profile 里注册依赖并建立 node_modules junction（离线，本地 file: 依赖）
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # npm 11 兼容坑
npm install --legacy-peer-deps --no-audit --no-fund --save ./KazPlugins/kaz-memory ./KazPlugins/kaz-shared
```

若 `package.json` 里已声明 `"kaz-memory": "file:KazPlugins/kaz-memory"`，则只需 `npm install --legacy-peer-deps --no-audit --no-fund` 重连 junction；`node_modules/kaz-memory` 会是指向 `KazPlugins/kaz-memory` 的 junction，改源目录即生效。

cordis.patch.yml 替换（宿主组合行）：

```yaml
- insert:
    - id: memory
      name: kaz-memory
```

改完重启 dsh + 强刷页面。代码级验证：

```powershell
node --check "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-memory\lib\index.js"
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-memory/lib/index.js').then(m=>console.log(m.name))"
# 期望输出：kaz-memory
```

## 探针

```powershell
# 宿主半逻辑探针（mock ctx + mock 引擎）：六工具、BM25、分页、指引、镜像、项目隔离
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-memory\probe-kaz-memory.mjs"
# 引擎集成探针（真实 cordis ctx + 真实 storage hub + 真实 MemoryEngine）：多项目根隔离落盘、
# 新格式时间戳落盘、旧格式读取迁移
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\kaz-memory\probe-engine.mjs"
```

## 验收要点

1. 新对话系统提示**不含记忆正文**；标记「自动载入」的记忆会作为上下文消息注入（仅一次），其余记忆由模型主动 `memory_search` + `memory_detail` 获取。
2. 面板每条记忆（含待确认建议）都有「自动载入」开关；勾选后条目旁显示紫色「自动载入」徽标。
3. 头部「记忆」按钮在 Kaz 按钮左侧；有 pending 记忆时绿点 + 数字，点击弹出记忆面板（待确认建议 / 全部记忆 / 刷新 / 打开文件夹按钮；时间戳按 ISO 字符串展示）。
4. 面板顶部有「打开全局记忆文件夹」「打开项目记忆文件夹」两个按钮；面板下方显示两个文件夹的路径。
5. 面板在侧边栏任意宽度下完整可见（portal + fixed 定位，不被裁切）。
6. 面板「确认生效」后该记忆 status 变 `applied`，`memory_list` 可查（只回 id/namespace/status/autoLoad/名称）。
6b. 面板「自动载入」开关触发 RPC `autoLoad` 端点，旧记忆无该字段时按 `false` 读。
6c. 记忆 `name` / `summary` 存在 JSON 里：保存时必填；面板「改名」经 RPC `rename` 写回 JSON；旧记录无 `name` 时按正文回退现算。
7. `memory_list` 返回项只有 `id/namespace/status/autoLoad/名称` 五项、**没有 content 与 keywords**；`memory_search` 只回摘要（id/name/summary/keywords/score，无 content），看全文用 `memory_detail`；**settings.yaml 的 `kaz-memory` 段仅作 standalone 兜底（指引 + bm25），Kaz 会话下生效值来自 kaz-defaults.json / 会话状态**。
7b. `memory_search` 按 BM25 分数降序、`limit`/`offset` 分页生效；`query` 为空报错；无命中返回空数组；`namespace`/`status` 过滤仍生效。
7c. `memory_detail` 按 id 返回 content_preview/total_length/has_more；`offset` 超出正文返回空串 + `has_more=false`；不存在的 id 报错。
7d. Kaz 面板 / `kaz-defaults.json` 里 `kaz-memory.bm25.k1/b` 修改后 `memory_search` 分数随之变化（下次请求生效）。
8b. 自动载入时机：对话开始（首个 pre-step）即注入一次已确认且勾选自动载入的记忆全文，每会话只注入一次。
9. 项目记忆按项目隔离：在 A 工作区 `memory_save(namespace=project)` 后，A 工作区的 `memory_list`/`memory_search`/`memory_detail` 能看到，B 工作区看不到；json 落在 `<A>/.dsh/storages/memory_project.json`，且桌面不再出现 `.dsh`。
10. 每一轮第一次调用 `memory_search` 后，注入一次遗忘指引，每个 turn 内不重复；`memory_forget` 不可用或插件关闭时不发。固定指引首轮工具调用后注入，并从下一轮起在每轮开头重复注入。
11. `memory_update` 可按 id 修改正文/标签/标题/摘要；修改 `applied` 记忆的正文后状态降级为 `pending`，只改标签/标题/摘要保持 `applied`；不存在的 id 报错。
12. 记忆 JSON 文件里新记录含 `created_at`/`updated_at`（ISO 字符串）与 `summary`，不再含 `createdAt`/`updatedAt` 数字键；旧文件记录照常读取（时间戳迁移为 ISO、summary 为空串），被更新后自动落新格式。

> **通道说明**：记忆面板已改走**专用 RPC 通道**（`/kaz-memory`，loopback），不经过 settings 网关，不再需要 `WEB_SETTINGS_NAMESPACES` 白名单补丁。若仍想通过配置界面编辑 kaz-memory 的配置段（`settings.yaml` 的 `kaz-memory` 段，含 bm25），才需要该白名单补丁（旧补丁可保留）。
