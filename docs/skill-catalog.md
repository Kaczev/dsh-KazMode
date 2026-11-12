# 七个方向的技能归属

本目录只做跨仓库导航，正文保持单一来源。相对链接要求仓库同级克隆；跨机器共享使用各仓库 README 中的技能入口。不要将 Windows 目录联接提交到 Git。

| 经验方向 | 唯一来源 | 处理方式 |
| --- | --- | --- |
| Unity／团结安全验收 | [unity-safe-verification](../../dsh-mcp-unity/skills/unity-safe-verification/SKILL.md) | 应用技能 |
| 自动化分层排障 | [automation-recovery](../kaz/skills/automation-recovery/SKILL.md) | Kaz 通用技能 |
| 基线迁移与测试隔离 | — | 已从 Kaz 移除，不再随包提供 |
| 图像去底与透明验收 | [white-background-to-alpha](../../dsh-photoshop-mcp/skills/white-background-to-alpha/SKILL.md) | 合并现有技能；配套 [Photoshop 文档流程](../../dsh-photoshop-mcp/skills/photoshop-safe-workflow/SKILL.md) |
| 素材选型与视觉一致性 | [visual-asset-production](../../dsh-comfyui-mcp/skills/visual-asset-production/SKILL.md) | 与 [Krea 专项技能](../../dsh-comfyui-mcp/skills/krea2-image-prompt/SKILL.md) 分工 |
| DSH 插件开发与发布 | — | 已从 Kaz 移除；使用当前环境提供的官方插件开发技能 |
| Windows 命令可靠执行 | [windows-command-reliability](../kaz/skills/windows-command-reliability/SKILL.md) | Kaz 通用技能 |

此表保留七个方向的归属与移除记录；已从 Kaz 移除的两个方向不再提供随包技能。将来有独立于现有范围的新技能，再按需要确定归属；已归属技能可用仓库 URL 加相对路径的清单连接，不复制正文，不依赖本机绝对链接。

## 整理边界

技能保留可重复方法、触发条件、分支处理与验收，不收个人偏好、本机路径、版本缺陷绕过或受测游戏具体解法。现有 Krea 技能包含历史本机模型和耗时参考，本次保留其记录并收紧触发范围，不将这些历史事实提升为通用保证。

## 本次验收与安装边界

Kaz 的三个随包技能由插件统一注册，不在本地 DSH 技能根另设同名副本或链接。提示词和技能更新后须核对哈希探针、注册与卸载及包内容。标准模式不安装或重载 Kaz，不修改 DSH profile；创造模式通过官方插件管理接口安装及执行真实宿主验收。表中属于其他仓库的技能可通过本地 DSH 技能根单独链接或同步，不能将磁盘可读称为宿主已加载。
