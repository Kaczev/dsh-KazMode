# create-plan

只有一个 `create_plan` 工具，用于鲸鱼自己把当前会话切换到 plan 模式。

- 挂在 Kaz 预设 `kaz/agent.cordis.yml` 的 `planning` isolate 组内，直接调用 `planMode.set(agent, true)`。
- `create_plan` 不在默认白名单，也不再由鲸鱼工作流自动放行——任务分类改由 `whale_report({mode:"plan"})` 统一启动 plan 模式；如需直接使用 `create_plan`，可在工具控制面板手动启用。
- 在 Kaz 面板关闭 `create-plan` 组件后，`create_plan` 不会进入工具面。
