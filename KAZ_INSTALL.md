# Kaz 插件安装说明（给负责安装的 DeepSeek）

## 目录结构

Kaz 相关插件统一放在：

```text
C:\Users\Kaczev\.dsh\profiles\web\KazPlugins\
```

当前包含 12 个插件：

| 插件 | 说明 |
|---|---|
| `kaz-mode` | Kaz 超级模式本体 |
| `kaz-no-context` | Kaz 预设降噪 |
| `thinking-anchor` | 思考锚点 |
| `round-minimal` | 首轮极简 |
| `tool-grouping` | 工具分组 |
| `tool-filter` | 工具过滤 |
| `code-collapse` | 工具塌缩 |
| `output-beep` | 输出提示音 |
| `round-display` | 每轮注入显示 |
| `deepseek-default-model` | DeepSeek 默认参数 |
| `kaz-memory` | 跨会话记忆 |
| `task-master-whiteboard` | 任务白板 |

`plugins\` 目录下只保留非 Kaz 插件：

```text
plugins\
├── dsh-deepseek-balance
└── dsh-super-injector
```

## 安装 / 迁移步骤

### 1. 放置插件目录

确保 `KazPlugins` 文件夹位于：

```text
C:\Users\Kaczev\.dsh\profiles\web\KazPlugins\
```

每个插件子目录内必须包含 `package.json` 和 `lib\`。

### 2. 更新 `package.json`

在：

```text
C:\Users\Kaczev\.dsh\profiles\web\package.json
```

中将 Kaz 插件的依赖路径写成：

```json
"code-collapse": "file:KazPlugins/code-collapse",
"round-minimal": "file:KazPlugins/round-minimal",
"thinking-anchor": "file:KazPlugins/thinking-anchor",
"tool-filter": "file:KazPlugins/tool-filter",
"tool-grouping": "file:KazPlugins/tool-grouping",
"output-beep": "file:KazPlugins/output-beep",
"round-display": "file:KazPlugins/round-display",
"deepseek-default-model": "file:KazPlugins/deepseek-default-model",
"kaz-memory": "file:KazPlugins/kaz-memory",
"kaz-mode": "file:KazPlugins/kaz-mode",
"kaz-no-context": "file:KazPlugins/kaz-no-context",
"task-master-whiteboard": "file:KazPlugins/task-master-whiteboard"
```

### 3. 创建 node_modules 链接

在 `node_modules` 中为每个 Kaz 插件创建 junction，指向 `KazPlugins` 下的对应目录。

PowerShell 示例：

```powershell
$web = "C:\Users\Kaczev\.dsh\profiles\web"
$names = @(
  "code-collapse","round-minimal","thinking-anchor","tool-filter",
  "tool-grouping","output-beep","round-display","deepseek-default-model",
  "kaz-memory","kaz-mode","kaz-no-context","task-master-whiteboard"
)

foreach ($name in $names) {
  $link = Join-Path $web "node_modules\$name"
  $target = Join-Path $web "KazPlugins\$name"
  if (Test-Path $link) { cmd /c rmdir "$link" }
  cmd /c mklink /J "$link" "$target"
}
```

### 4. `cordis.patch.yml`

不需要修改。

`cordis.patch.yml` 只包含插件开关配置，不包含路径映射。

### 5. 锁文件

如果使用 npm / pnpm，建议同步更新：

- `package-lock.json`
- `pnpm-lock.yaml`

把其中 `file:plugins/...` 改成 `file:KazPlugins/...`。

### 6. 验证

在 `profiles\web` 下运行：

```powershell
node -e "const {createRequire}=require('module'); const req=createRequire(process.cwd()+'/package.json'); console.log(req.resolve('kaz-mode'))"
```

如果输出指向：

```text
C:\Users\Kaczev\.dsh\profiles\web\KazPlugins\kaz-mode\lib\index.js
```

说明安装正确。

## 默认设置位置

Kaz 模式默认设置文件：

```text
C:\Users\Kaczev\.dsh\profiles\web\KazPlugins\kaz-mode\kaz-defaults.json
```

对话专属设置文件：

```text
<项目根目录>\.dsh\kaz-session-states.json
```

## 注意

- 不要用 `Remove-Item` 删除 junction，使用 `cmd /c rmdir`。
- 迁移后需要重启 dsh web 才能加载新路径。
- 如果插件加载异常，先检查 `node_modules\<插件名>` 是否是 junction 且指向 `KazPlugins\<插件名>`。
