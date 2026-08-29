# output-beep —— 模型输出完毕提示音

> **作用**：模型输出完毕 / 提问弹窗 / plan 方案提交弹窗出现时让电脑"滴"一声，提醒你可以切回来继续打字（模型推理时间可能很长，作者摸鱼专用 🐳）。

宿主侧插件：监听 `agent/status` 事件，任意 agent 输出完毕（回到 `idle`）时
播放一次 **Windows 系统提示音**（PowerShell `[console]::beep`，频率/时长可配）。
模型流式输出结束后电脑会"叮"一声，方便切走窗口后回来；plan 模式下模型调用
`exit_plan_mode` 提交方案、Plan review 弹窗出现时也会响一声。

## 特性

- **独立工作**：不依赖 Kaz 模式。装了就能用（默认 `enabled: true`）。
- **Kaz 面板开关**：Kaz 模式把它作为被管理插件，Kaz 面板里有 `output-beep`
  配置行（enabled / includeSubagents 开关，按会话生效）。
- **plan 方案提交提示**：模型调用 `exit_plan_mode` 提交方案、Plan review
  弹窗出现时同样响一声（与提问共用 enabled / frequency / duration 配置）。
- **子代理过滤**：默认只对主会话提示；子代理（background subagent / workflow /
  ralph 的子会话）输出完毕时同样会发 `agent/status`，但默认不提示，避免连响。
  `includeSubagents: true` 开启。
- **防抖**：同一时刻多个 agent 同时 idle 时 200ms 内只响一次。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
output-beep:
  enabled: true           # 总开关（默认开）
  includeSubagents: false # 子代理输出完毕也提示（默认关）
  frequency: 1000         # 提示音频率 Hz（范围 37–32767，默认 1000）
  duration: 300           # 提示音时长 ms（默认 300）
```

> 纯方案 A：Kaz 模式下生效配置由 kazMode 服务按会话读取，settings.yaml 段不再被
> kaz-mode 改写、也不再自动补写。

## 安装（与其它插件一致，KazPlugins 目录）

```powershell
Copy-Item ".\output-beep" "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\output-beep" -Recurse -Force
cd "$env:USERPROFILE\.dsh\profiles\web"
Remove-Item Env:npm_config_allow_scripts
npm install --legacy-peer-deps --no-audit --no-fund --save ./KazPlugins/output-beep
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
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\output-beep\probe-output-beep.mjs"
```

## 验收要点

1. 模型输出完毕后电脑发出一次提示音（本会话第一轮结束就会响——注意别被吓到）。
2. Kaz 面板出现 `output-beep` 行，`enabled` 开关可关可开，关闭后不再提示。
3. 关闭 Kaz 模式后插件仍按独立生效配置工作。
4. `includeSubagents: true` 后子代理完成也提示。
5. plan 模式下模型调用 `exit_plan_mode` 提交方案时，Plan review 弹窗出现的同时响一声。
