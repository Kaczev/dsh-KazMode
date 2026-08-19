# dsh-deepseek-balance

DeepSeek 账户余额悬浮挂件（DSH Web UI 插件）。在页面右下角显示一个小挂件，随时显示 DeepSeek 账户余额；可以拖拽，松手时靠近屏幕边缘会自动吸附，并记住上次位置。

## 功能

- **余额随时可见**：默认每 60 秒自动刷新，切回标签页时也会立即刷新；也可以点挂件上的 `↻` 手动刷新。
- **拖拽吸附**：按住挂件任意位置拖动，松手时若靠近屏幕左/右/上/下边缘，会自动吸附到边缘；位置保存在 `localStorage`。
- **API Key 不暴露给浏览器**：浏览器只访问 DSH 本地的 `/dsh-deepseek-balance/balance` 代理路由，真正的 DeepSeek API Key 由 Node 端读取并使用，不会下发到前端。
- **状态提示**：余额可用时显示绿点，不可用/获取失败时显示红点；悬停可查看赠送余额、充值余额和更新时间。

## 余额来源

插件从 DeepSeek 官方接口获取余额：

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```

Node 端读取 API Key 的顺序：

1. 插件配置 `apiKey`（可选）
2. 环境变量 `DEEPSEEK_API_KEY`
3. `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`

当前机器已有 `~/.dsh/.credentials.yaml`，因此安装后无需额外配置。

## 安装

在 DSH 环境中执行：

```bash
dsh plugin --profile web add link:D:/workspaceD/dsh-deepseek-balance
```

如果 `dsh plugin` 没有自动把插件加入 bundle，请手动检查 `~/.dsh/profiles/web/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-deepseek-balance"
      ]
    }
  }
}
```

然后重启 DSH Web UI：

```bash
dsh web
# 或你平时使用的启动命令
```

刷新浏览器页面后，右下角会出现余额挂件。

## 开发

```bash
cd dsh-deepseek-balance
npm run build
```

构建脚本会生成：

- `lib/index.js`：Node 端（余额代理路由）
- `lib/client.js`：浏览器端（拖拽吸附挂件）

## 配置项

目前不需要配置界面。若想通过插件配置传入 API Key，可在 profile 的 `cordis.patch.yml` 中给插件行附加配置，例如：

```yaml
- insert:
    - id: deepseek-balance
      name: dsh-deepseek-balance
      config:
        apiKey: sk-xxxx
```

## 隐私说明

- 插件不会在浏览器端保存或展示 API Key。
- 余额请求由 DSH 本机 Node 进程代理发出，浏览器只看到本地 JSON 响应。
- 挂件位置仅保存在浏览器 `localStorage`，不会上传。

## License

MIT