# output-beep —— 模型输出完毕提示音

宿主侧插件：监听 `agent/status` 事件，任意 agent 输出完毕（回到 `idle`）时
播放一次 **Windows 系统提示音**（PowerShell `[console]::beep`，频率/时长可配）。
模型流式输出结束后电脑会"叮"一声，方便切走窗口后回来。

## 特性

- **独立工作**：不依赖 Kaz 模式。装了就能用（默认 `enabled: true`）。
- **Kaz 面板开关**：Kaz 模式把它作为第 6 个被管理插件，右上角 Kaz 面板里有
  `output-beep` 配置行（enabled / includeSubagents 开关）。
- **子代理过滤**：默认只对主会话提示；子代理（background subagent / workflow /
  ralph 的子会话）输出完毕时同样会发 `agent/status`，但默认不提示，避免连响。
  `includeSubagents: true` 开启。
- **防抖**：同一时刻多个 agent 同时 idle 时 200ms 内只响一次。

## settings（`~/.dsh/settings.yaml`，热重载）

```yaml
output-beep:
  enabled: true           # 总开关（默认开）
  includeSubagents: false # 子代理输出完毕也提示（默认关）
  frequency: 1000         # 提示音频率 Hz（范围 37–32767，默认 1000）
  duration: 300           # 提示音时长 ms（默认 300）
```

## 安装（与其它插件一致）

```powershell
Copy-Item ".\output-beep" "$env:USERPROFILE\.dsh\profiles\web\plugins\output-beep" -Recurse -Force
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm install --legacy-peer-deps --no-audit --no-fund --save ./plugins/output-beep
```

cordis.patch.yml 追加：

```yaml
- insert:
    - id: output-beep
      name: output-beep
      config:
        enabled: true
```

改完重启 dsh + 强刷页面（代码改动必须重启）。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\plugins\output-beep\probe-output-beep.mjs"
```

## 验收要点

1. 模型输出完毕后电脑发出一次提示音（本会话第一轮结束就会响——注意别被吓到）。
2. Kaz 面板出现 `output-beep` 行，`enabled` 开关可关可开，关闭后不再提示。
3. 关闭 Kaz 模式后插件仍按 settings.yaml 的 `enabled` 独立工作。
4. `includeSubagents: true` 后子代理完成也提示。

> **部署白名单注意**：Kaz 面板经 api 网关 settings 通道读写 `output-beep`
> 命名空间，网关白名单（`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`）需
> 加入 `output-beep`（升级 dsh 会覆盖本地补丁，需重新加回）。
