// kaz-context-policy —— 上下文三件与压缩提醒的挂载点。
//
//   context_compress              按内容定位、一次压一段（§3.7）
//   context_search                查会话原文（§3.8；带 companion 可查别人的）
//   context_read                  按序号取完整原文、供取证（§3.8.5）
//   compression-hint              占用 ≥50% 时注入一行提醒（§四）
//
// 本插件挂在预设的 compaction 组里（与 @deepseek-ai/dsh-compaction-basic 同组），
// 这样 ctx.compaction / ctx.tokenMeter 都能在同组解析到。

import { contextCompressTool } from "./compress.js";
import { contextReadTool } from "./read.js";
import { installHintSection } from "./reminder.js";
import { contextSearchTool } from "./search.js";

export const name = "kaz-context-policy";

export const inject = ["tools", "systemPrompt"];

export function apply(ctx) {
  ctx.tools.register(contextSearchTool(ctx));
  ctx.tools.register(contextCompressTool(ctx));
  ctx.tools.register(contextReadTool(ctx));
  installHintSection(ctx);
}
