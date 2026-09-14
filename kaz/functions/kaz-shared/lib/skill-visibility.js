// kaz-shared —— 技能可见性的唯一事实源：哪些技能**不**给子代理看。
//
// 口径（用户 2026-09 定的）：**黑名单 + 默认给**。
//   * 列表里的技能名 → 子代理看不到（不出现在技能目录里，也载入不了）。
//   * 不在列表里的 → 主代理与子代理都能用。
//
// 为什么用黑名单而不是白名单：
//   * 现有 14 个技能里，绝大多数（PowerShell、写作、界面、Office、取证纪律……）**子代理同样需要**。
//     白名单要为每个工种技能登记一遍，而"忘了登记"会让子代理悄悄少一个技能——这个失误很隐蔽。
//   * 真正**只该给主代理**的是编排类：它们讲的是"派谁、什么时候派、怎么验收"，
//     子代理不决定这些，读了只会困惑或被误导。这类是少数，列出来更省事。
//
// ⚠ 维护风险（写在这里，因为这是本文件唯一的失败模式）：
//   以后新增**编排类**场景技能时（维修类、审查类、已有计划类……各自都会有一部分编排内容），
//   **必须把它的 name 加进下面这个列表**，否则它会漏给子代理。
//   与 blacklists.js 同一个道理：名单是唯一事实源，漏登记不会报错，只会静默放行。
//
// 实现：见 functions/skill-visibility/lib/index.js（包装官方 filesystem provider 做过滤）。

/**
 * 只给主代理的技能名（kebab-case，与 SKILL.md 的 `name` 完全一致）。
 *
 * 判断依据只有一条：**这个技能是在教"怎么编排多个代理/多个角色"，还是在教"怎么干这类活"？**
 * 前者进列表，后者不进。
 */
export const MAIN_AGENT_ONLY_SKILLS = Object.freeze([
  "building-something-new",
  "working-from-a-plan",
  "repairing-something-broken",
  "reviewing-someone-elses-work",
  "moving-or-upgrading-a-thing",
]);
