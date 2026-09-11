// kaz-shared —— 私有插件生命周期常量 + 技能闭环能力可用性判断（纯 ESM）
// ===========================================================================
// v0.9 B3.5：skill Review 复盘文案已移除；本文件继续保留生命周期与私有目录
// 常量，以及 skillLifecycleCallable（供内部执行器判断闭环基础工具是否可见）。
// 私有过程目录固定为用户 profile 的私有目录
// KazPrivatePlugins/process（SKILL_PRIVATE_DIR_NAME/SKILL_PROCESS_DIR_NAME）。
// ===========================================================================

import { toolCallable } from "./review-guidance.js";

/** 私有技能根目录名（用户 profile 下，不在公共 repo 内）。 */
export const SKILL_PRIVATE_DIR_NAME = "KazPrivatePlugins";

/** 私有过程文档根目录名（在 SKILL_PRIVATE_DIR_NAME 之下）。 */
export const SKILL_PROCESS_DIR_NAME = "process";

/** 每个安全边界最多落地的技能变更数（硬上限，禁止批量提取/落地）。 */
export const SKILL_BOUNDARY_MAX_CHANGES = 1;

/** 技能闭环的基础工具：任一可见即可判断具备闭环能力；完整闭环还需 pwsh 跑验证。 */
export const SKILL_LIFECYCLE_TOOLS = Object.freeze(["write", "edit", "pwsh", "safe_json_write"]);

/**
 * 当前代理环境是否具备走技能闭环的基础能力。
 * 1) 复用 review-guidance.js 的 toolCallable 可用性判定；
 * 2) 只要 write / edit / pwsh / safe_json_write 中任一可见即返回 true；
 * 3) 服务读不到或全部不可见时按“不可用”处理（返回 false）。
 */
export function skillLifecycleCallable(services, agent) {
  for (const name of SKILL_LIFECYCLE_TOOLS) {
    try {
      if (toolCallable(services, agent, name) === true) return true;
    } catch {
      // 单个工具判定异常不影响其余候选工具
    }
  }
  return false;
}
