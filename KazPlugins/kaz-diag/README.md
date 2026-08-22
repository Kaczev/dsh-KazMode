# kaz-diag —— Kaz 模式诊断插件

> **作用**：给模型一个只读状态工具 `kaz_mode_status`，让它能汇报 Kaz 模式当前状态（开关、插件启停、工具面、首阶段信号等）——调试 Kaz 模式时用。

只做一件事：注册只读状态工具 **`kaz_mode_status`**，报告 Kaz 模式当前状态。
2026-08 重构：状态工具从 kaz-mode 移出，独立成插件——**本插件开启时，
`kaz_mode_status` 才注册并加入 Kaz 模式的全部工具列表**（与 kaz-memory 工具同款
条件）；关闭时工具不注册、也不进入 Kaz 工具面。

## 状态报告内容

- **Kaz 模式开关**（kaz-mode.enabled）与**预设联动**（agent-presets.default）；
- **固定系统提示词**（`You are a helpful software engineer assistant.`）；
- **被管理插件启停**：thinking-anchor / round-minimal / plugin-filter / output-beep /
  round-display / deepseek-default-model / kaz-memory / kaz-diag，含开启 Kaz 前的
  原始状态快照与**本会话生效**状态（纯方案 A：模式默认 + 会话覆盖）；
- **Kaz 工具面**：toolWhitelist 白名单（= Kaz 全部工具的唯一闸门），并给出动态
  调整后的实际工具面：
  - kaz-memory 关闭 → 六个记忆工具自动移出；
  - kaz-diag 关闭 → `kaz_mode_status` 自动移出；
- **round-minimal 信号**：首次工具调用前 = 首阶段极简；之后恢复全部工具。

## settings（纯方案 A：Kaz 会话下经 Kaz 面板/kazMode 服务生效；此处仅 standalone 兜底）

```yaml
kaz-diag:
  enabled: true   # 总开关：注册 kaz_mode_status（并加入 Kaz 工具面）
```

> 纯方案 A：Kaz 模式下生效配置由 kazMode 服务按会话读取，settings.yaml 段不再被
> kaz-mode 改写、也不再自动补写。

## 使用

```text
调用 kaz_mode_status（无参数）→ 返回完整状态报告文本。
```

## 安装（与其它插件一致）

KazPlugins 目录随 profile 以 `file:` 依赖 + junction 装配；`cordis.patch.yml` 插入
`kaz-diag` 行（config: `enabled: true`）。改完**重启 dsh + 强刷页面**。

## 验收要点

1. `kaz-diag: enabled: false` 时：`kaz_mode_status` 不在任何会话的工具列表里；
2. `enabled: true` 时：工具出现；进入 Kaz 模式后它也在 Kaz 全部工具列表里；
3. 调用返回的报告中"有效白名单"一栏应包含 `kaz_mode_status`。
