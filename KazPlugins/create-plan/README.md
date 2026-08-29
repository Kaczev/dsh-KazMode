# create-plan

只有一个 `create_plan` 工具：plan 模式的 realm 内桥，供鲸鱼工作流与手动使用切换 plan 模式。

- 挂在 Kaz 预设 `kaz/agent.cordis.yml` 的 `planning` isolate 组内，因此可以直接解析 `planMode` 服务（与 `exit_plan_mode` 同一个 realm）。
- `create_plan` 支持 `active` 参数：`true`（默认）进入 plan 模式，`false` 退出 plan 模式。
- `create_plan` 不在默认白名单，也不再由鲸鱼工作流自动放行——任务分类改由 `whale_report({mode:"plan"})` 统一启动 plan 模式；`whale_report` 在 host 层解析不到 `planMode`，会通过 `tools.get("create_plan")` 拿到本工具定义并直接执行，借用本组 realm 完成进入/退出。
- 如需直接使用 `create_plan`，可在工具控制面板手动启用。
- 在 Kaz 面板关闭 `create-plan` 组件后，`create_plan` 会拒绝执行（纵深防御）。
