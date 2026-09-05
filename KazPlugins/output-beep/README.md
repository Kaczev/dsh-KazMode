# output-beep —— 模型需要用户输入时提示音

> **作用**：默认只在模型真正需要你输入时让电脑"滴"一声：`ask_user_question`
> 提问弹窗、`exit_plan_mode` 提交方案（Plan review 弹窗）。旧版“模型输出完毕
> （agent 回到 idle）就响”默认关闭，需要时打开 `idleBeep: true` 恢复（作者
> 摸鱼专用 🐳）。

宿主侧插件：监听 `session/event` 的 `ask_user_question` / `exit_plan_mode`
工具调用，用户输入弹窗或 Plan review 弹窗出现时播放一次 **Windows 系统提示音**
（PowerShell `[console]::beep`，频率/时长可配）。`agent/status` idle（输出完毕）
提示默认不再播放；`idleBeep: true` 可恢复旧版行为。

## 特性

- **独立工作**：不依赖 Kaz 模式。装了就能用（默认 `enabled: true`）。
- **用户输入提醒**：模型调用 `ask_user_question` 提问、或 `exit_plan_mode`
  提交方案时立即响一声，提醒你回来操作。
- **idleBeep（旧版输出完毕提示，默认关）**：`idleBeep: false` 时输出完毕
  不响；`idleBeep: true` 恢复“任意 agent 回到 idle 响一次”。
- **Kaz 面板开关**：Kaz 模式把它作为被管理插件，Kaz 面板里有 `output-beep`
  配置行（enabled / idleBeep / includeSubagents 开关，按会话生效）。
- **子代理过滤**：默认只对主会话提示；子代理（background subagent / workflow /
  ralph 的子会话）的提示事件默认忽略，避免连响。`includeSubagents: true` 开启。
- **防抖**：同一时刻多个 agent 同时 idle 时 200ms 内只响一次。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
output-beep:
  enabled: true           # 总开关（默认开）
  idleBeep: false         # 输出完毕（agent 回到 idle）也提示（默认关）
  includeSubagents: false # 子代理也提示（默认关）
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

1. 模型调用 `ask_user_question` 提问、或 `exit_plan_mode` 提交 plan 方案时响一声。
2. 默认（`idleBeep: false`）模型输出完毕 / agent 回到 idle **不再**自动响。
3. `idleBeep: true` 后模型输出完毕重新恢复提示音。
4. Kaz 面板出现 `output-beep` 行，`enabled` / `idleBeep` 开关可关可开。
5. `includeSubagents: true` 后子代理的提示事件也响。
