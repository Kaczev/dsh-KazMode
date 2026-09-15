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

/**
 * 写入某个对话的阶段（读—改—写）。cwd/sessionId 缺失时不动文件，返回 false。
 *
 * 注意：**必须保留本对话之外的键**。这个文件里还住着 `__rounds`（轮次标记），而
 * `readStages()` 会把它过滤掉（它只认"值是字符串"的键）。如果拿 readStages 的结果回写，
 * `__rounds` 会被整个抹掉——实测踩过：阶段一写入，轮次标记就没了，于是计数又从零开始。
 * 所以这里读的是**原始 JSON**，只改自己那一个键。
 */
export async function writeStage(cwd, sessionId, stage) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const file = stageFile(cwd);
  const all = await readRaw(cwd);
  all[sessionId] = String(stage);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return true;
}

/** 读原始 JSON 对象（不筛键）；文件缺失/损坏时按空对象处理。给"读—改—写"用。 */
async function readRaw(cwd) {
  try {
    const parsed = JSON.parse(await readFile(stageFile(cwd), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 轮次账本的**落盘**部分：`{ "<对话id>": { lastRoundSeq } }`。
 *
 * 为什么必须落盘：self-check 的相位是"每 4 轮一次"，而计数器原先只活在内存里——
 * 进程一重启就归零，于是**开头几条消息被吞掉不计**。开发期重启很勤，表现为"永远到不了第 4 轮"。
 * 落盘后跨重启存活：重启后从"上次数到的那条用户消息"之后接着数，不重数、也不丢。
 *
 * 存的是**最后数过的那条用户消息的 seq**，不是计数本身——计数可以由事件流重建，
 * 而"数到哪了"必须在事件流之外记着，否则重启会把同一批消息再数一遍或漏数。
 */
export async function readRoundMarks(cwd) {
  try {
    const parsed = JSON.parse(await readFile(stageFile(cwd), "utf8"));
    const marks = parsed?.__rounds;
    if (marks === null || typeof marks !== "object" || Array.isArray(marks)) return {};
    const out = {};
    for (const [key, value] of Object.entries(marks)) {
      const seq = value?.lastRoundSeq;
      if (typeof seq === "number" && Number.isFinite(seq)) out[key] = { lastRoundSeq: seq };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入某个对话的轮次标记（读—改—写）。缺失时不动文件，返回 false。 */
export async function writeRoundMark(cwd, sessionId, lastRoundSeq) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (typeof lastRoundSeq !== "number" || !Number.isFinite(lastRoundSeq)) return false;
  const file = stageFile(cwd);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    parsed = undefined;
  }
  const all = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const marks = all.__rounds !== null && typeof all.__rounds === "object" && !Array.isArray(all.__rounds) ? all.__rounds : {};
  marks[sessionId] = { lastRoundSeq };
  all.__rounds = marks;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return true;
}
