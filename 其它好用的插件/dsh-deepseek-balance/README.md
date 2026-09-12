# dsh-deepseek-balance

DeepSeek 账户余额悬浮挂件 —— 一枚给 **DSH Web UI**（DeepSeek Harness `0.1.5-rc.2`）用的浏览器插件。

一个能拖的玻璃小卡片，实时显示你的 DeepSeek 余额：数字是**老虎机式滚动**的，底下是一条**带虚影和颜色**的余额折线，钱掉得越猛卡片抖得越厉害、颜色越红。

```
┌────────────────────────────┐
│ ● DeepSeek 余额      ▾  ↻ │   ● 绿=正常 黄=数据滞后 红=拿不到
│ 4 4 . 7 2 5 0 CNY  -0.1840 │   ← 数字以老虎机方式滚到新值
│ ╭──────────────╮           │
│ │  折线 + 虚影  │           │   ← 颜色随跌幅剧烈程度变化
│ ╰──────────────╯           │
│ 本次 ¥0.184   还能撑 6.2 天 │
└────────────────────────────┘
```

## 功能

- **实时余额**：浏览器每 **2.5 秒**问一次本地路由，宿主端 **8 秒**才真正打一次 DeepSeek 官网并缓存结果 —— 肉眼看几乎同步，但不会把上游打爆（`/dsh-deepseek-balance/stats` 可以看实际次数）。
- **折线虚影**：当前折线之下叠着三层更淡、更高一点的旧迹，像余晖一样拖着走；折线本身是贝塞尔平滑曲线，曲线下方有渐变填充。
- **颜色表示剧烈程度**：每一段线单独上色，从青灰（几乎没动）→ 绿 → 琥珀 → 橙 → 红（剧烈下跌）。参考尺度取「一次 API 调用量级（¥0.005）」与「余额的 1%」的几何平均，所以 ¥5 和 ¥5000 的账户都读得出轻重。
- **暴跌会抖动**：单次跌幅越过阈值时，整卡左右抖一下 + 从卡片边缘扩散一圈水波纹，颜色同步变红。
- **老虎机数字**：每一位数字是一条 0-9 的带子，物理旋转到新值（走环上最短路径、逐位错开落定、落定前有回弹），转得快时会带一点动态模糊。
- **自动吸附**：拖到任意位置松手，离哪条边近就吸到哪条边；位置存在 `localStorage`，重启浏览器还在。窗口缩放会被夹回可视区域。
- **低余额预警**：低于阈值（默认 ¥10）时整卡呼吸式红晕，标题变成「DeepSeek 余额 · 偏低」。
- **本会话已花 / 还能撑多久**：前者是挂件首次读到余额与当前的差额；后者按最近观测到的消耗速率外推，没在花钱时显示 `—`，不编数字。
- **悬停采样点**：鼠标在折线上移动会显示竖直参考线和浮层（那一刻的余额、时间、与上一点的差值）。
- **可收起**：点 `▾` 折成一枚小胶囊（状态点 + 数字），再点 `▴` 展开。
- **跟随主题**：全部使用 DSH 的设计变量（`--dsw-*`），亮色/暗色主题自动适配；`prefers-reduced-motion` 下关闭全部动画。

## API Key 从不进浏览器

浏览器只访问本机路由，真正的调用在 Node 端完成。Key 的解析顺序：

1. 插件配置 `apiKey`（可选，不推荐写在共享机器上）
2. DSH 凭据服务 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` —— 在「设置 → 模型」页填的 Key 会被自动读到，改完不用重启
3. 启动环境变量 `DEEPSEEK_API_KEY`
4. `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`

四条都没有时，卡片会明确告诉你缺 Key，而不是静默失败。

## 安装

插件目录 = 本仓库的 `其它好用的插件/dsh-deepseek-balance`。装进 web profile：

```powershell
# 1. 让 profile 能解析到这个包（开发机上可以直接用 Junction 指回源目录）
New-Item -ItemType Junction `
  -Path  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-deepseek-balance" `
  -Target "<克隆下来的仓库>\其它好用的插件\dsh-deepseek-balance"

# 2. 把插件挂进 profile 的 bundle 列表：
#    %USERPROFILE%\.dsh\profiles\web\package.json
#      dependencies 里加   "dsh-deepseek-balance": "file:dsh-deepseek-balance",
#      dsh.profile.bundles 里加 "dsh-deepseek-balance"

# 3. 重启 dsh web，浏览器刷新页面
```

重启后在页面右下角会出现挂件。`dsh --profile web --dump-config` 里应该能看到 `id: deepseek-balance` 这一行。

> 注意：**不要在 profile 里跑 `pnpm install`**，那会去 registry 找这个包。它是本地包，靠上面的 Junction / `file:` 依赖解析。

## 开发

```powershell
node scripts/build.mjs          # src/ → lib/（宿主半直接拷贝，浏览器半套上 module-loader 外壳）
node scripts/probe.mjs          # 宿主半：Key 解析、真实上游调用、路由、缓存/冷却/并发合并
node scripts/widget-probe.mjs   # 浏览器半：SSR 渲染、reel/颜色/续航等纯函数、canvas 绘制调用
node scripts/preview.mjs        # 生成 dev/preview.html（真 CSS + 真绘制函数的五个场景）
powershell -File scripts/snapshot.ps1   # 无头 Edge 渲染，并读回画布像素判定
node scripts/live-probe.mjs 3225 30     # 起一个临时 dsh web，统计真实轮询次数
node scripts/observe-probe.mjs 3300 18  # 端到端：从页面内部回传请求、可见数字、历史条数
```

`lib/` 是构建产物，需要提交（用户克隆后无需构建即可用）。

## 配置项

在 profile 的 `cordis.patch.yml` 里覆盖本插件的行即可（profile 层在 bundle 层之后应用）：

```yaml
- id: deepseek-balance
  config:
    cacheTtlMs: 8000             # 上游缓存新鲜窗口
    staleGraceMs: 120000         # 上游失败后还能拿旧数据撑多久
    lowBalanceThreshold: 10      # 低余额预警阈值（按余额币种）
    apiKeyEnv: DEEPSEEK_API_KEY  # 凭据/环境变量名
    # apiKey: sk-...             # 直接写死（不推荐）
```

## 路由

| 路径 | 用途 |
| --- | --- |
| `/dsh-deepseek-balance/balance` | 挂件轮询的 JSON；宿主端缓存 + 请求合并，`stale` 标记是否用的旧数据 |
| `/dsh-deepseek-balance/stats` | 只读计数（服务次数、上游次数、缓存余额、Key 来源），排查「挂件不更新」用 |

两个路由都只暴露余额与计数，不含 Key。

## 目录

```
dsh-deepseek-balance/
├── src/index.js       宿主半：Key 解析、上游调用、缓存、路由
├── src/client.js      浏览器半：挂件、老虎机、canvas 折线、抖动、吸附
├── scripts/           构建 + 五层验证脚本
├── cordis.patch.yml   本包作为 bundle 时插入的插件行
├── package.json       dsh.bundle.patch / dsh.client 声明
└── lib/               构建产物（index.js + client.js）
```

## 已知限制

- 余额只有 DeepSeek 在我们发起请求后才会变，所以「实时」的上限是**轮询间隔**，不存在推送式的即时余额。
- 折线保留 **60 个采样点**（约 2.5 分钟）；「还能撑几天」是按这个窗口外推的短期估算，不是账单预测。
- 只显示 `CNY`（找不到时退回第一个币种）。
- 颜色刻度是针对 DeepSeek 的单次调用成本标定的；如果哪天定价量级大变，改 `MIN_VIOLENCE_SCALE` 与 `BIG_MOVE_FRACTION` 两个常量即可。

## License

MIT
