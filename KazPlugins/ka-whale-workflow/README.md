# ka-whale-workflow

鲸鱼工作流组件：用户消息后先「任务重构」，再「任务分类」，然后放行 Kaz 白名单。

- 任务重构：工具面 = 「ka-whale-workflow 配置面板代码框清单 ∩ Kaz 白名单」+ 自动启用面板临时放行的 `whale_report`。
- 任务分类：工具面 = `whale_report`；`whale_report({mode})` 统一启动 plan/goal 模式。
- `whale_report`：重构/分类各调用一次，向插件汇报阶段完成；分类时可传 `mode`（`normal` / `plan` / `goal`，goal 需带 `objective`）。plan 模式由 `whale_report` 内部通过 `create_plan` 工具（planning isolate 组内）切换，因此分类工具面保持只有 `whale_report`。
- 补充信息：第 2、3、4……轮（turn≥2、模型不在运行）直接重新进入「任务重构」。**插话（模型运行中同一轮中途追加消息）不改变当前工作流阶段**。
- round-minimal 优先：首次工具调用前不进入重构，第一次工具调用后立刻进入。
- 阶段状态写入插件自己的 JSON 存储（`~/.dsh/storages/ka-whale-workflow-stage.json`，按 session id 索引），重启/续接会话自动恢复；**不再写会话事件**（自定义会话事件会让 dsh 重载日志时拒绝整条会话）。

## 设置

- `enabled`：总开关（Kaz 面板可开关）。
- `includeSubagents`：子代理是否也走工作流，默认关。
- `reconstructionTools`：任务重构工具清单，Kaz 面板中以代码框展示/编辑（与其它输入框同底色，逗号分隔，默认八个工具）。

## 工具自动启用

`whale_report` 不在默认白名单里，由「Kaz 模式工具自动启用」面板的「鲸鱼工作流」临时放行（重构 + 分类）。`create_goal` / `create_plan` 不再由工作流自动放行；分类的模式启动由 `whale_report` 内部完成。
