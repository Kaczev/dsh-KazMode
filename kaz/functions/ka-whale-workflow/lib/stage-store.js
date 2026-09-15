// ka-whale-workflow —— 阶段的持久化（跨重启保留）。
//
// 一个项目一份文件：<项目>/.dsh/storages/workflow_stages.json
// 结构：{ "<对话id>": "<阶段>", … }——一个对话一个键，不拆成多个 json。
// 写回走"读—改—临时文件—改名"，避免写一半留下坏文件。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 阶段文件路径：项目目录下的 .dsh/storages/workflow_stages.json。 */
export function stageFile(cwd) {
  return join(String(cwd ?? ""), ".dsh", "storages", "workflow_stages.json");
}

/** 读取整张阶段表（文件缺失/损坏时按空表处理）。 */
export async function readStages(cwd) {
  try {
    const parsed = JSON.parse(await readFile(stageFile(cwd), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 同步读某个对话的阶段。**只给"每次 system-prompt 装配都要问一次"的调用方用**
 * （工具面门禁），所以刻意用同步 IO：异步在这里会让装配多等一个微任务，
 * 而且要处理并发。读不到就返回 ""（按"不在任何特殊阶段"处理）。
 * @param {object} session - 会话（需要有 header.cwd 与 id）。
 * @returns {string} 阶段名，读不到时返回空串。
 */
export function readStageSync(session) {
  const cwd = session?.header?.cwd;
  const sessionId = session?.id;
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  if (typeof sessionId !== "string" || sessionId.length === 0) return "";
  try {
    const parsed = JSON.parse(readFileSync(stageFile(cwd), "utf8"));
    const value = parsed?.[sessionId];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** 读取某个对话的阶段；没有记录时返回 undefined。 */
export async function readStage(cwd, sessionId) {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  const value = (await readStages(cwd))[sessionId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 写入某个对话的阶段（读—改—写）。cwd/sessionId 缺失时不动文件，返回 false。 */
export async function writeStage(cwd, sessionId, stage) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const file = stageFile(cwd);
  const all = await readStages(cwd);
  all[sessionId] = String(stage);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return true;
}
