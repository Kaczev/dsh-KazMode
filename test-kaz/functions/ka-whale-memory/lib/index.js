// ka-whale-memory —— 记忆六工具插件（设计稿 §3.1–3.6）。
//
// 工具注册在预设 scope 上：主代理与子代理都看得见，但主代理的写三件
//（save / update / forget）由 kaz-core 的工具面门按 §2.1 收掉。

export const name = "ka-whale-memory";

export const inject = ["tools"];

import {
  memoryDetailTool,
  memoryForgetTool,
  memoryListTool,
  memorySaveTool,
  memorySearchTool,
  memoryUpdateTool,
} from "./tools.js";

export function apply(ctx) {
  const tools = [
    memorySearchTool(),
    memoryDetailTool(),
    memoryListTool(),
    memorySaveTool(),
    memoryUpdateTool(),
    memoryForgetTool(),
  ];
  for (const tool of tools) ctx.tools.register(tool);
}
