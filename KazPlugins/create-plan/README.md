# create-plan

只有一个 `create_plan` 工具，用于鲸鱼自己把当前会话切换到 plan 模式。

- 挂在 Kaz 预设 `kaz/agent.cordis.yml` 的 `planning` isolate 组内，直接调用 `planMode.set(agent, true)`。
- `create_plan` 不在默认白名单；由「Kaz 模式工具自动启用 → 鲸鱼工作流 → 各模式的启动工具」在任务分类阶段临时放行。
- 在 Kaz 面板关闭 `create-plan` 组件后，`create_plan` 不会进入工具面。
