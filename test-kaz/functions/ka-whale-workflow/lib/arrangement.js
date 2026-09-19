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

/** 安排里允许的保留 persona 值。 */
export const RESERVED_PERSONAS = Object.freeze(["main", "memoryMaintainer", "slopCleaner"]);

/** 工具面写死、因而条目上的黑名单无效的保留角色（派发点按角色分支固定发给平台）。 */
export const PERSONAS_WITH_FIXED_TOOL_FACE = Object.freeze(["memoryMaintainer", "slopCleaner"]);

/**
 * 校验 persona：只允许 "main"、"memoryMaintainer"、"slopCleaner"，或 [role, description]（恰好两个非空字符串）。
 * @param {unknown} persona - 主代理写的 persona。
 * @returns {{value: string|string[], error?: undefined}|{value?: undefined, error: string}}
 */
export function personaValueOf(persona) {
  if (typeof persona === "string") {
    const value = persona.trim();
    if (RESERVED_PERSONAS.includes(value)) return { value };
    return { error: `persona "${value}" is not allowed — use "main", "memoryMaintainer", "slopCleaner", or [role, description]` };
  }
  if (Array.isArray(persona)) {
    if (persona.length === 2 && persona.every((part) => typeof part === "string" && part.trim().length > 0)) {
      return { value: [persona[0].trim(), persona[1].trim()] };
    }
    return { error: 'persona array must be exactly [role, description] — two non-empty strings' };
  }
  return { error: 'persona must be "main", "memoryMaintainer", "slopCleaner", or [role, description]' };
}

/**
 * 会话 id 的形状：字母数字加 `-_.`，1–200 字。**只校验形状，不校验它是否还活着**——
 * "这个会话此刻还在不在"是派发那一刻的事实，写安排时问不出来，只能由派发点判断。
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * 会被当成布尔开关的字符串：`"true"` 这类值**形状上**完全像会话 id（字母数字、没有空格），
 * 所以光靠形状检查拦不住它们，必须单列。
 *
 * 为什么宁可单列也不放松形状检查：这个字段名叫 `fork`，读起来就像开关，模型写 `"true"`
 * 是最有代表性的一种误用；放它过去就等于把它当成一个永远查不到的会话 id，子代理全新开始而
 * 回执照写 "forked from"（2026-09-19 实测）。拿一个（根本不会存在的）会话 id 恰好叫
 * `"true"` 的风险，远小于让这种误用继续静默通过。
 */
const BOOLEAN_LIKE_FORK_VALUES = new Set(["true", "false", "yes", "no", "on", "off", "y", "n"]);

/** `fork` 允许的两种值：`"main"`（主代理自己）、或一个会话 id。 */
export const FORK_FROM_MAIN = "main";

/**
 * 校验 `fork`：**只有 `"main"` 和一个会话 id 是合法的**，别的一律报错。
 *
 * 与黑名单那条同一个立场（见 `normalizeEntry` 里那段）：静默忽略一个写错的值，比报错更坏。
 * 早先这里只检查"是不是非空字符串"，于是布尔误用（`true` / `"true"` / `"yes"`）一路活到派发点，
 * 在那里被当成一个永远找不到的会话 id——子代理全新开始，而回执照样写 "forked from"。
 *
 * @param {unknown} raw - 条目上的 `fork`。
 * @returns {{value: string|null, error?: undefined}|{value?: undefined, error: string}}
 *   `null` 表示这次派发不 fork（没写、`null`、空串都归到这里）。
 */
export function forkValueOf(raw) {
  if (raw === undefined || raw === null) return { value: null };
  const reject = (shown) =>
    ({
      error: `fork must be "main" or a subagent session id, got ${shown} — this field is not a boolean switch. Write "main" to inherit your own conversation, name a live subagent id, or leave the field out for a fresh subagent.`,
    });
  if (typeof raw !== "string") return reject(`${JSON.stringify(raw) ?? String(raw)} (${typeof raw})`);
  const text = raw.trim();
  if (text.length === 0) return { value: null };
  if (BOOLEAN_LIKE_FORK_VALUES.has(text.toLowerCase())) return reject(JSON.stringify(raw));
  if (text === FORK_FROM_MAIN) return { value: FORK_FROM_MAIN };
  if (SESSION_ID_SHAPE.test(text)) return { value: text };
  return reject(JSON.stringify(raw));
}

/**
 * 校验并规范化一个安排条目（程序字段一律重置）。
 * @param {unknown} raw - 主代理写的条目。
 * @returns {{entry: object, error?: undefined}|{entry?: undefined, error: string}}
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "each entry must be an object" };
  const persona = personaValueOf(raw.persona);
  if (persona.error !== undefined) return { error: persona.error };
  const personaValue = persona.value;
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  if (task.length === 0) return { error: `entry ${JSON.stringify(personaValue)} needs a task` };
  const blacklist = Array.isArray(raw.blacklist)
    ? raw.blacklist.filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => name.trim())
    : [];
  // 保留角色的工具面是固定的（写死在派发点的分支里），条目上写的黑名单不会生效。静默忽略等于
  // 让写的人以为自己收窄了权限——这里直接拒掉并说清原因（2026-09-17 验证者实测：条目黑名单被忽略）。
  if (blacklist.length > 0 && PERSONAS_WITH_FIXED_TOOL_FACE.includes(typeof personaValue === "string" ? personaValue : "")) {
    return {
      error: `persona "${personaValue}" has a fixed tool face: a blacklist on this entry would be ignored, so it is rejected instead. Drop the blacklist field, or use [role, description] if you need to narrow a subagent's tools.`,
    };
  }
  const fork = forkValueOf(raw.fork);
  if (fork.error !== undefined) return { error: `entry ${JSON.stringify(personaValue)}: ${fork.error}` };
  const forkValue = fork.value;
  return {
    entry: {
      persona: personaValue,
      blacklist,
      task,
      ...(forkValue !== null ? { fork: forkValue } : {}),
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
