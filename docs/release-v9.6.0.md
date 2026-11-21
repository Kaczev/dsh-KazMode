# 9.6.0

新增两个按需加载的视觉技能，并在[系统提示词](../kaz/prompt.md)的条件协议中接入触发规则：

- [`ui-taste`](../kaz/skills/ui-taste/SKILL.md)：区分可直接渲染的 HTML 视觉方案、高密度应用/插件界面与展示型网页；要求 90%–95% 中性底色、单强调色、最多两层容器嵌套、4px/8px 间距刻度、具体动词按钮文案和克制的交互过渡，避免滥用蓝紫渐变、多层套娃卡片与滚动淡入。
- [`icon-craft`](../kaz/skills/icon-craft/SKILL.md)：规范界面线形图标、真实品牌标志与文件类型图标的选择和底色适配，随包附带零依赖单进程解析脚本 [`icons.mjs`](../kaz/skills/icon-craft/scripts/icons.mjs)、预量测边界索引 [`index.json`](../kaz/skills/icon-craft/assets/index.json) 与样式表 [`icon.css`](../kaz/skills/icon-craft/assets/icon.css)。支持 `--inline` 输出单文件 HTML 可直接内联的 `<svg>` 或 `data:image/svg+xml` 标记，也支持写入本地图标目录并生成 `icons-credits.json`。脚本改编自 MIT 许可的 `Leonxlnx/taste-skill`，不使用子进程或命名管道，兼容 Windows 受限沙箱。

同步更新包清单描述、中英文界面文案、许可致谢与 README。宿主加载器、客户端标记槽位及原有三个技能保持不变。

## 验证与边界

- `npm run check`：版本一致性、npm README 同步检查与自动化测试。
- `node scripts/sync-skill.mjs --verify`：写作技能正文与上游来源记录一致。
- `icons.mjs` 实测：索引检索、单文件 `--inline` 内联输出、本地目录写出及 `icons-credits.json` 生成。
- `npm pack ./kaz --dry-run` 与 `git diff --check`：核验发布体积、包含文件与补丁格式。

`icons.mjs` 首次拉取未缓存的图标集时需访问 `cdn.jsdelivr.net`，拉取后缓存在系统临时目录（可通过 `ICON_CRAFT_CACHE` 指定路径），生成的页面本身不发起运行时 CDN 请求。提示词与技能是给模型的工作要求，实际视觉质量仍受所用模型、宿主主题与预览核验条件影响。
