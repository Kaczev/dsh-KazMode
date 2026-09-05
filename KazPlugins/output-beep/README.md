# output-beep —— 用户介入 / Kaz 收尾提示音

> **作用**：在模型真正需要用户介入时，或 Kaz 主模型收尾完成时，让电脑“滴”一声。
> 默认**不会**在普通“模型输出完毕”时响。

## 触发时机

1. **Kaz 主模型收尾完成**：主模型 workflow 处于 `communication` / `done` 且 agent 回到 idle 时响；
2. **提问弹窗**：模型调用 `ask_user_question` 时立即响；
3. **Plan 方案提交**：模型调用 `exit_plan_mode` 时响（Kaz 模式已无 plan 模式，但 output-beep 独立使用/非 Kaz 仍兼容）。

子代理完成、普通 stage idle、非 communication 收尾都不会触发。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
output-beep:
  enabled: true           # 总开关（默认开）
  includeSubagents: false # 子代理也提示（默认关）
  frequency: 1000         # 提示音频率 Hz（范围 37–32767，默认 1000）
  duration: 300           # 提示音时长 ms（默认 300）
```

> 无 `idleBeep` 设置；“任意输出完毕即响”的旧版行为已移除。

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

1. 普通模型输出完毕（非 communication/done）不响。
2. Kaz 主模型 communication/done 收尾完成时响一次。
3. `ask_user_question` / `exit_plan_mode` 弹窗出现时响。
4. Kaz 面板显示 `output-beep` 行；关闭 `enabled` 后全部静默。
5. `includeSubagents` 默认关，子代理完成不响。
