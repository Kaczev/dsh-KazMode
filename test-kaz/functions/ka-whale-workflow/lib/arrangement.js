// ka-whale-workflow —— 安排文件（《Kaz8.0设计.md》§5.2）。
// 存储：<项目>/.dsh/storages/arrangements/<对话 id>.json，一个对话一个 JSON
// （与阶段文件 workflow_stages.json 同根）。cwd 缺失时才退回 home 的 storages。
// 主代理写 persona/blacklist/task/fork；id/status/summary 由程序回填/搬运。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** summary 超长截断的长度（设计稿：取首行、超长截断）。 */
export const SUMMARY_MAX_CHARS = 200;

/** 安排目录：项目目录下的 .dsh/storages/arrangements（cwd 为空时退回 home）。 */
export function arrangementsDir(cwd) {
  const base =
    typeof cwd === "string" && cwd.trim().length > 0 ? join(cwd.trim(), ".dsh") : (process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  return join(base, "storages", "arrangements");
}

export function arrangementFile(cwd, sessionId) {
  const safe = String(sessionId ?? "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(arrangementsDir(cwd), `${safe.length > 0 ? safe : "unknown"}.json`);
}

/** 取一行：压平空白 + 超长截断。 */
export function firstLine(text, max = SUMMARY_MAX_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 校验并规范化一个安排条目（程序字段一律重置）。
 * @param {unknown} raw - 主代理写的条目。
 * @returns {{entry: object, error?: undefined}|{entry?: undefined, error: string}}
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "each entry must be an object" };
  const persona = raw.persona;
  let personaValue;
  if (typeof persona === "string" && persona.trim().length > 0) {
    personaValue = persona.trim();
  } else if (
    Array.isArray(persona) &&
    persona.length === 2 &&
    persona.every((part) => typeof part === "string" && part.trim().length > 0)
  ) {
    personaValue = [persona[0].trim(), persona[1].trim()];
  } else {
    return { error: 'persona must be "main", "memoryMaintainer", or [role, description]' };
  }
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  if (task.length === 0) return { error: `entry ${JSON.stringify(personaValue)} needs a task` };
  const blacklist = Array.isArray(raw.blacklist)
    ? raw.blacklist.filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => name.trim())
    : [];
  const fork = typeof raw.fork === "string" && raw.fork.trim().length > 0 ? raw.fork.trim() : "";
  return {
    entry: {
      persona: personaValue,
      blacklist,
      task,
      ...(fork.length > 0 ? { fork } : {}),
      id: "",
      status: "pending",
      summary: "",
    },
  };
}

export async function readArrangement(cwd, sessionId) {
  try {
    const parsed = JSON.parse(await readFile(arrangementFile(cwd, sessionId), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeArrangement(cwd, sessionId, entries) {
  const dir = arrangementsDir(cwd);
  await mkdir(dir, { recursive: true });
  const file = arrangementFile(cwd, sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await rename(tmp, file);
  return entries;
}

/** 按下标回填一个条目；返回更新后的数组。 */
export async function patchEntryAt(cwd, sessionId, index, patch) {
  const entries = await readArrangement(cwd, sessionId);
  if (index < 0 || index >= entries.length) return entries;
  const next = entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
  await writeArrangement(cwd, sessionId, next);
  return next;
}

/**
 * 从一条"子代理完成通知"里取出回填信息。
 * 通知 = user/message，source.kind === "subagent-settled"；
 * 正文含运行时一句话 + "Its closing message:" + 子代理的收尾消息。
 * @param {object} event - 会话事件。
 * @returns {{childId: string, status: "done"|"failed", summary: string}|null}
 */
export function settlePatchFromNotice(event) {
  const source = event?.data?.source;
  if (source === null || typeof source !== "object" || source.kind !== "subagent-settled") return null;
  const blocks = Array.isArray(event.data.content) ? event.data.content : [];
  let closing = "";
  const marker = blocks.findIndex((block) => typeof block?.text === "string" && block.text.trim() === "Its closing message:");
  if (marker >= 0) {
    closing = blocks
      .slice(marker + 1)
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join(" ");
  }
  const runtimeSummary = typeof source.summary === "string" ? source.summary : "";
  const status = /finished and will do no further work/.test(runtimeSummary) ? "done" : "failed";
  return {
    childId: typeof source.senderSessionId === "string" ? source.senderSessionId : "",
    status,
    summary: firstLine(closing.length > 0 ? closing : runtimeSummary),
  };
}
