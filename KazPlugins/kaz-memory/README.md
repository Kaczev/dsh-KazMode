# kaz-memory —— 带「自动载入」的独立记忆插件

与 `@max-null/dsh-memory` 同功能的跨会话明文记忆；默认**不注入记忆正文**，但首轮工具调用后会注入一条记忆指引，首次使用 `memory_search` 后会再注入一条清理遗忘指引；对每条记忆可标记「自动载入」，在**对话开始时**自动注入一次（2026-08 重构：不再等 memory_search 首次可用）：

| | @max-null/dsh-memory | kaz-memory |
| --- | --- | --- |
| 引擎 / 存储 | MemoryEngine，`$DSH_HOME/storages/memory.json`（global）+ `<cwd>/.dsh/storages/memory_project.json`（project） | **vendored 同一引擎（MIT），格式不变**；global 存 `$DSH_HOME/storages/memory.json`，project 按**项目文件夹**各存一份 `<项目>/.dsh/storages/memory_project.json`（2026-08-17 起不再用 `process.cwd()`） |
| 五工具 | memory_save / memory_update / memory_list / memory_search / memory_forget | `memory_update` 可更新正文/标签/标题；`memory_list` 只返回 id/namespace/status/名称（不含正文与 keywords），memory_search 返回全文 |
| 固定指引 | tool:memory | 首轮工具调用后以上下文消息注入一次固定指引；首次 `memory_search` 后再注入一次遗忘指引；已确认且标记自动载入的记忆会在对话开始时自动注入一次；之后需要更完整/精确记忆时主动 memory_search |
| 上下文注入 | `memory:recall` 把 applied 记忆逐条注入系统提示 | **按需注入一次**：已确认（applied）且标记「自动载入」（autoLoad）的记忆，在**对话开始**（首个 pre-step）以上下文注入方式注入一次；其余记忆靠模型主动 memory_search |
| 人工确认闸门 | setStatus 仅存于服务层，**无 UI / 工具 / CLI（断头路）** | 客户端半：会话头部「记忆」按钮（Kaz 按钮左侧，order -2）+ 面板（待确认：确认生效/忽略/删除；**全部记忆：点标题按需取全文 / 改名 / 删除**），经**专用 Connection RPC 通道 `/kaz-memory`（loopback）**读写——settings.yaml 不再承载任何记忆存储信息；模型没有任何对应工具 |

## 设计要点

- **name 入 JSON（2026-08-19）**：每条记录持久化 `name` 字段（保存/确认时自动从正文的标题行/首行生成，
  ≤140 字）；面板可「改名」，改完写回 JSON。旧记录没有 `name` 时读取端按旧逻辑从正文现算（不强制迁移）。
- **自动载入（2026-08-19 引入，2026-08 重构触发时机）**：每条记忆新增 `autoLoad` 布尔字段（默认 `false`，旧记录读作 false，
  即「目前的记忆都先不自动载入」）。面板可逐条切换「自动载入」，已确认且标记的记忆在
  **对话开始时**（首个 `agent/pre-step`，step === 1，不再等 memory_search 可用）以
  `source: {kind:'plugin', form:'recall'}` 的用户消息**注入一次**；每个会话只注入
  一次。**只注入 status=applied 且 autoLoad=true 的记忆**，pending/ignored 不注入。
  跨重启去重（2026-08-19）："已注入"标记持久化在 `~/.dsh/storages/kaz-memory-auto-injected.json`
  （agent/session id 集合，仅实际注入成功后落标）；插件加载时还会预标记当前已存在的所有
  agent（thinking-anchor 同款）——dsh 重启后恢复的会话不会重复注入，新会话仍正常注入一次。
- **其余记忆按需拉取**：未标记自动载入的记忆不进上下文，模型需要时主动 `memory_search`。
- **memory_list 只回名称（2026-08-16）**：`memory_list` 只返回 `id / namespace / status / 名称`
  （名称取标题行/首行截断 ≤140 字），**不含正文与 keywords**——避免一次列表调用把记忆灌进
  上下文干扰当前任务。要看具体内容用 `memory_search`（按关键词返回全文）。
- **项目记忆按项目文件夹隔离（2026-08-17）**：project 记忆不再写 dsh 进程的
  `process.cwd()`（那会把所有项目的记忆混进桌面之类的地方），而是写到
  **`<项目文件夹>/.dsh/storages/memory_project.json`**。项目根从调用工具的 agent
  会话 cwd（`exec.agent.session.header.cwd`）解析；配置 `projectRoot` 可显式覆盖；
  无 agent / 无配置时才兜底 `process.cwd()`。引擎按项目根**懒加载独立存储域**，
  每个项目文件夹一份 json、互不混淆。面板镜像与「项目记忆」只显示
  **当前会话所在项目**的那份，并标注项目路径。
  **只读不建目录（2026-08-17）**：JSON 后端一打开域就会 `mkdir` 根目录，所以引擎
  的读路径（list/search/镜像）只在项目文件**已存在**时才打开域，否则直接返回空——
  只有 `memory_save` 写入才会真的创建 `<项目>/.dsh/storages`，杜绝在桌面等无关
  目录被读操作凭空建出 `.dsh/storages`。
- **面板项目跟随工作区（2026-08-19 改为 RPC）**：客户端（root 作用域按钮收到 `useSessions`）
  读取 `current` 会话的 `SessionSummary.cwd`（用户当前选中的会话 = 正在看的工作区），每次 RPC
  调用都显式带上 `project` 参数；宿主据此读对应项目文件夹的记忆，无需进程内项目根上报。
- **面板桥接机制（2026-08-19 改为专用 RPC）**：宿主在 `ctx.connection.rpc` 注册
  **`/kaz-memory` 通道（authority=loopback）**，提供 `list` / `open` / `rename` / `status` /
  `autoLoad` / `forget` / `openFolder` 端点：`list` 返回元数据（id/namespace/status/autoLoad/名称/
  时间戳/project，无正文、按 updatedAt 倒序）+ 两个记忆文件夹路径；`open` 按需取正文；
  `rename` 把新名称写回 JSON；`status`/`autoLoad`/`forget` 对应确认/忽略/自动载入/删除；
  `openFolder` 打开对应记忆文件夹。**settings.yaml 不再承载任何记忆存储信息**（
  memories/opened/paths/actions 全部移除），记忆本体（含 name）始终只在明文 JSON 文件里；
  面板打开时拉取一次 + 每 2 秒轮询 + 手动刷新按钮（模型用记忆工具改数据也会在轮询中反映）。
- **打开记忆文件夹按钮（2026-08-17）**：面板顶部两个按钮——「打开全局记忆
  文件夹」「打开项目记忆文件夹」，分别打开 `memory.json` 与当前项目
  `memory_project.json` 所在目录（宿主 `explorer`/`open`/`xdg-open`，路径先
  `mkdir -p` 确保存在）。
- **面板不被侧边栏裁剪（2026-08-17）**：记忆面板经 `createPortal` 挂到
  `document.body`，按按钮矩形 fixed 定位、自动在视口内收拢（宽度不足时向上/
  向左回退），侧边栏再窄也不会挡住面板。
- **消息格式（2026-08-17 起精简；2026-08-21 改为主动行动式措辞；2026-08-22
  改为首轮工具调用后注入）**：记忆指引
  是**首轮工具调用之后以上下文消息注入一次**的**固定短提示**——`[kaz-memory guidance] / > / 内容 / <` 信封格式，只发
  一行 We need 风格英文总述（**主动行动式**：任务开始时先用 memory_search 查记忆、
  学到重要事实后用 memory_save 存下来——而不是等遇到难题才想起记忆）；记忆工具
  的具体用法由各工具描述自带，不再逐行重复 A/B/C/D。**仅当 memory_search 在当前
  环境确实可调用时发送**（存在且可直接使用，或 Code Mode 下经 run_code SDK 可调用；
  注册了但工具面/白名单不含它、首轮极简等不可调用场景一律不发）；不可用即返回空串，
  不向模型发无意义的指引。**首次 `memory_search` 之后**还会以同一信封格式再注入
  **一条遗忘指引**（`We need to forget memories (memory_forget) related to tasks that
  have been completed and no longer need to be retained.`），提醒模型清理已完成且不再
  需要保留的任务记忆；该指引同样每会话只注入一次，且仅在 `memory_search` 与
  `memory_forget` 都可用时发送。Kaz 模式会滤掉 systemPrompt 段，因此固定指引不再注册
  `tool:memory:kaz-memory` 系统提示段，改为 `agent/pre-step` 合成用户消息注入；
  部署基础英文记忆指引段（`tool:memory`）仍在组装层**无条件移除**。
- **总开关（2026-08-21）**：settings.yaml `kaz-memory` 段的 `enabled`（默认
  `true`，Kaz 模式面板提供开关）。关闭时：不注入记忆指引、不自动载入记忆，
  客户端完全不渲染记忆面板（侧边栏「记忆」按钮与面板整体隐藏）；开启时
  按原有逻辑自动判断。
- **指引配置（2026-08-17）**：settings.yaml `kaz-memory` 段生效字段——
  `guidance`（旧字段，整段覆盖，非空时完全取代固定提示与遗忘指引，兼容保留）与
  `guidanceHead`（固定提示总述行覆盖，留空 = 内置默认）与
  `guidanceForget`（遗忘指引覆盖，留空 = 内置默认；此前保留兼容但不再生效，
  现随首次 memory_search 后的遗忘指引恢复生效）；`guidanceSearch` /
  `guidanceSave` / `guidanceList` 仍保留兼容但**不再生效**（工具细节
  已并入各工具描述）。Kaz 模式面板的 kaz-memory 行提供 `enabled` 开关与
  `guidanceHead` 配置入口。
- **闸门（含 memory_update）**：模型 memory_save 仍然只能写 `pending`，只有人在面板点「确认生效」
  才会置为 `applied`；「忽略」置为 `ignored`（参考，不注入）；「删除」即 forget。
  `memory_update` 可修改已有记忆的正文/标签/标题；**修改 applied 记忆的正文会把它降级回
  `pending`**，需人工再次确认，只改标签/标题不降级。
  「自动载入」开关只由面板操作（模型没有对应工具）；未确认的记忆即使勾选也不注入。
- **状态命名（2026-08 起）**：对外统一 `pending`（待确认）/ `ignored`（已忽略）/ `applied`（已生效）；
  旧 JSON 里的 `suggested` / `suggest` / `auto` 读取时自动映射到新值，写回时逐步落新值，无需手工迁移。

## 存储位置（2026-08-17 起）

- **全局记忆**：`$DSH_HOME/storages/memory.json`（本机 `C:\Users\Kaczev\.dsh\storages\memory.json`）。
- **项目记忆**：每个项目文件夹一份 `<项目>/.dsh/storages/memory_project.json`，
  例如 `C:\Users\Kaczev\Desktop\ds初见工作区\.dsh\storages\memory_project.json`、
  `C:\Users\Kaczev\Documents\GitHub\RootOfDecite\RootOfDecite\.dsh\storages\memory_project.json`。
- **历史迁移**：旧版误放在 `C:\Users\Kaczev\Desktop\.dsh\storages\memory_project.json`
  的 3 条 RootOfDecite 项目记忆已于 2026-08-17 迁移到 RootOfDecite 项目文件夹，
  桌面 `.dsh` 已删除。

## 安装（与其它五个插件同一套路）

```powershell
Copy-Item ".\kaz-memory" "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-memory" -Recurse -Force
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts   # npm 11 兼容坑
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/kaz-memory
npm uninstall --no-audit --no-fund @max-null/dsh-memory   # 撤掉旧组件
```

cordis.patch.yml 替换（宿主组合行）：

```yaml
- insert:
    - id: memory
      name: kaz-memory
```

改完重启 dsh + 强刷页面。代码级验证：

```powershell
node --check "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-memory\lib\index.js"
node --input-type=module -e "import('file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/kaz-memory/lib/index.js').then(m=>console.log(m.name))"
# 期望输出：kaz-memory
```

## 探针

```powershell
# 宿主半逻辑探针（mock ctx + mock 引擎）：工具、指引、镜像、openFolder、项目隔离
node "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-memory\probe-kaz-memory.mjs"
# 引擎集成探针（真实 cordis ctx + 真实 storage hub + 真实 MemoryEngine）：多项目根隔离落盘
node "$env:USERPROFILE\.dsh\profiles\web\plugins\kaz-memory\probe-engine.mjs"
```

## 验收要点

1. 新对话系统提示**不含记忆正文**（无 `Remembered preferences` 注入段）；标记「自动载入」的记忆会作为
   上下文消息注入（仅一次），其余记忆由模型主动 `memory_search` 获取。
2. 面板每条记忆（含待确认建议）都有「自动载入」开关；勾选后条目旁显示紫色「自动载入」徽标，
   `autoLoad` 元数据随 RPC `list` 同步到面板。
3. 头部「记忆」按钮在 Kaz 按钮左侧；有 pending 记忆时绿点 + 数字，点击弹出记忆面板：
   上方「待确认建议」（自动载入/确认生效/忽略/删除）、「全部记忆」（点标题打开/收起全文、改名、
   自动载入开关、删除按钮带确认弹窗）。面板打开时拉取 + 每 2 秒轮询 + 手动刷新按钮。
4. 面板顶部有「打开全局记忆文件夹」「打开项目记忆文件夹」两个按钮，点击在文件管理器中
   打开对应 json 所在文件夹；面板下方显示两个文件夹的路径。
5. 面板在侧边栏任意宽度下完整可见（portal + fixed 定位，不被裁切）。
6. 面板「确认生效」后该记忆 status 变 `applied`，`memory_list` 可查（只回 id/namespace/status/autoLoad/名称）。
6b. 面板「自动载入」开关触发 RPC `autoLoad` 端点，旧记忆无该字段时按 `false` 读（默认不自动载入）。
6c. 记忆 `name` 存在 JSON 里：保存/确认时自动生成；面板「改名」经 RPC `rename` 写回 JSON；
   旧记录无 `name` 时按正文回退现算。
7. 调用 `memory_list` 确认返回项只有 `id/namespace/status/autoLoad/名称` 五项、**没有 content 与 keywords**；
   `memory_search` 才返回全文；**settings.yaml 的 `kaz-memory` 段只剩 guidance 配置，无任何记忆存储信息**。
8b. 自动载入时机：对话开始（首个 pre-step）即注入一次已确认且勾选自动载入的记忆全文，
    不依赖 memory_search 是否可用；每会话只注入一次。
9. 项目记忆按项目隔离：在 A 工作区 `memory_save(namespace=project)` 后，
   A 工作区的 `memory_list`/`memory_search` 能看到，B 工作区看不到；json 落在
   `<A>/.dsh/storages/memory_project.json`，且桌面不再出现 `.dsh`。
10. 首次调用 `memory_search` 后，会话中注入一次遗忘指引（`[kaz-memory guidance]` 信封、
    `We need to forget memories (memory_forget) ...`）；非 memory_search 工具调用不会触发；
    `memory_forget` 不可用或插件关闭时不发。
11. `memory_update` 可按 id 修改正文/标签/标题；修改 `applied` 记忆的正文后状态降级为
    `pending`，只改标签/标题保持 `applied`；不存在的 id 报错。

> **通道说明**：记忆面板已改走**专用 RPC 通道**（`/kaz-memory`，loopback），不经过 settings 网关，
> 不再需要 `WEB_SETTINGS_NAMESPACES` 白名单补丁。若仍想通过配置界面编辑 kaz-memory 的
> guidance 配置段（`settings.yaml` 的 `kaz-memory` 段），才需要该白名单补丁（旧补丁可保留）。
