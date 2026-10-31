# Kaz 9.4.0

## 更新

- 在原有 `write-like-a-person` 基础上新增 `automation-recovery`、`baseline-isolation`、`windows-command-reliability`、`dsh-plugin-field-guide`，共五个随包技能；启用 Kaz 时统一注册，禁用时撤销，不需要在本地技能根重复安装。
- 提示词增加状态回读、未知效果处理及按需加载详细流程的简短规则。
- 扩展技能 frontmatter、完整正文、注册回滚与卸载测试，补充技能归属导航。

## 验证

- `npm run check`：21 项测试通过。
- `npm pack ./kaz --dry-run`：五个技能及配套资源均纳入发布包。
- 当前 DSH 真实宿主中，五个技能均通过技能工具从 Kaz 包内加载。
- 实际会话系统消息中，禁用后 Kaz 完整正文为 0 份，重新启用后恰好 1 份。
- 当前浏览器实时 Slot 检查中，禁用后标题区与新会话区标记均撤销，重新启用后两处各恢复一份；未另做截图级画面检查。

## 使用

在 DSH 插件页安装 `dsh-kazmode@9.4.0` 并启用，继续使用原有标准、PTC 或自定义预设。更新后的生效方式以插件管理器返回结果为准。
