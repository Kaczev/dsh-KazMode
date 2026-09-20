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
 * persona 的角色名（派发时按什么匹配，这里就取什么）：数组取第 0 项，纯字符串取自身，
 * 别的给空串（`normalizeEntry` 到这一步 persona 一定合法，所以空串只是防御）。
 *
 * 与 tools.js 的 `personaKey` 是同一个取值方式——两处必须一致，否则校验认的保留角色和派发认的
 * 不是同一个。**这里不管长度**：报错里怎么裁是 `boundedShown` / `personaLabel` 的事。
 *
 * 声明在 `personaValueOf` / `forkValueOf` 之前是有意的：那两个函数会在被调用时用到下面这组
 * 回显工具，读代码的人从上往下就能看到它们是什么。
 *
 * @param {string|string[]} personaValue - 已通过 personaValueOf 的值。
 * @returns {string} 角色名。
 */
export function personaNameOf(personaValue) {
  if (Array.isArray(personaValue)) return personaValue[0];
  return typeof personaValue === "string" ? personaValue : "";
}

/**
 * 报错里回显**原始值**时最多印多少个字符。
 *
 * 为什么必须有上界：写安排的是模型，它把一个字段写错位置时，值可能是几千到几万个字符
 * （实测形态：主代理把整段任务正文塞进 persona 数组的第二项）。报错原样回显，这段正文就
 * 整段进到它的上下文里，而它多半已经从别处收过一遍了——一次形状错误因此变成一次上下文事故。
 * 截断并写明省了多少，比原样回显更诚实：模型看到的是"值太长、被切了"，而不是"值就这么长"。
 */
export const ERROR_ECHO_MAX_CHARS = 200;

/**
 * 有界回显一个原始值：JSON 化（字符串带引号、其它值就是字面量），超长则截断并写明省了多少字符。
 *
 * **这是 `ka-whale-workflow` 里唯一允许回显模型原始值的地方**（tools.js 也从这里 import）。任何新写的报错
 * 只要要印一个模型给的值，就必须过这一道——"这条一定很短"的历史判断已经错过两次：先是 E6 的
 * 数组第二项（行为描述），再是派发回执里的黑名单与角色名。
 *
 * **别把这句读成"整个预设都盖住了"——它不是。**已知两处同类的、未做有界化的回显，都在本预设行
 * 里，都在本次改动范围之外（没有批准修它们，所以留着）：
 *   * `kaz-context-policy/lib/search.js:81` —— `unknown companion "${wanted}"`，`wanted` 来自
 *     `context_search` 的 `companion` 参数（纯字符串、无 `maxLength`）。5 万字入参实测 **50,044** 字。
 *   * `ka-whale-memory/lib/tools.js:234` —— `no memory named "${String(args.name ?? "")}"`，`name`
 *     是 `{type:"string",required:true}`，五处参数声明都没有 `maxLength`。5 万字入参实测 **50,027** 字。
 * 也就是说"这条报错有多长"这件事，本文件保证的只是**走这条路径的那些**。下一处落地前先量一遍，
 * 别按这份注释推断。
 *
 * `JSON.stringify` 会抛的两种值（BigInt、循环引用）走 `String(value)` 兜底：它们**到不了**这里
 * （工具的入参是 JSON 解析出来的，两个都构造不出来），但这个函数是导出的、会被复用到别处，
 * 一个"回显函数在回显时抛异常"的失败模式比回显得难看坏得多——抛出去会让整条报错路径变成
 * 一个未捕获异常。
 *
 * 被切的可能正好是**代理对的一半**：那样会产出孤立代理（显示成 U+FFFD，看起来像原值里本来就有
 * 乱码）。所以切点落在高位代理上时往前多让一个字符。
 *
 * @param {unknown} value - 要回显的值。
 * @returns {string} 有长度上界的回显文本：单次回显 ≤ 222 字。**有界是逐处的，不是逐条消息的**——
 *   一条派发回执最多同时拼进四个回显，实测能到 ~900 字，见测试文件 5p。
 */
export function boundedShown(value) {
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= ERROR_ECHO_MAX_CHARS) return text;
  const head = text.slice(0, ERROR_ECHO_MAX_CHARS - 1);
  const safe = /[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head;
  return `${safe}… (+${text.length - safe.length} more chars)`;
}

/**
 * 校验 persona：只允许 "main"、"memoryMaintainer"、"slopCleaner"，或 [role, description]（恰好两个非空字符串）。
 * @param {unknown} persona - 主代理写的 persona。
 * @returns {{value: string|string[], error?: undefined}|{value?: undefined, error: string}}
 */
export function personaValueOf(persona) {
  if (typeof persona === "string") {
    const value = persona.trim();
    if (RESERVED_PERSONAS.includes(value)) return { value };
    return { error: `persona ${boundedShown(value)} is not allowed — use "main", "memoryMaintainer", "slopCleaner", or [role, description]` };
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

/** `fork` 的两个定向值：`"main"`（从主代理自己的对话继承）与 `"none"`（这次不 fork）。 */
export const FORK_FROM_MAIN = "main";

/**
 * `"none"`：**显式的"不 fork"**，与"不写这个字段"完全等价（两者存下来是同一种条目：没有
 * `fork` 字段），所以在派发点没有第二种含义，也不可能出现"显式 none 和省略打起来"。
 *
 * 为什么值得给一个动作词：`fork` 现在是个需要判断的字段——"要不要把这个对话的前情交给这个
 * 新角色"——有判断就会想明确表态。不给 `"none"` 含义时，它在**形状上是个完全合法的会话 id**
 * （字母数字、无空格），于是被当成一个查不到的会话投递，回执还印一句"目标不是活会话"，看
 * 起来像"我说了 none 所以没 fork"，实际含义完全不同。一个明确含义，比让这个猜测静默落到别的
 * 分支上诚实。
 *
 * 为什么不认 `false` 而认 `"none"`：`false` 在同一个字段上和 `true` 是一对，认一个就得认另一个，
 * 而 `true` 是这次要修掉的起点（它会被当成布尔开关，字形上还撞得上会话 id）。`"none"` 是与
 * `"main"` 同一层的字符串，不打开布尔这扇门。
 */
export const FORK_NONE = "none";

/**
 * 校验 `fork`：**只有 `"main"`、`"none"` 和一个会话 id 是合法的**，别的一律报错。
 *
 * 与黑名单那条同一个立场（见 `normalizeEntry` 里那段）：静默忽略一个写错的值，比报错更坏。
 * 早先这里只检查"是不是非空字符串"，于是布尔误用（`true` / `"true"` / `"yes"`）一路活到派发点，
 * 在那里被当成一个永远找不到的会话 id——子代理全新开始，而回执照样写 "forked from"。
 *
 * @param {unknown} raw - 条目上的 `fork`。
 * @returns {{value: string|null, error?: undefined}|{value?: undefined, error: string}}
 *   `null` 表示这次派发不 fork：**没写**、`null`、空串、以及显式的 `"none"` 都归到这里。
 */
export function forkValueOf(raw) {
  if (raw === undefined || raw === null) return { value: null };
  const reject = (shown) =>
    ({
      error: `fork must be "main" (inherit your own conversation), "none" (start a fresh subagent), or a subagent session id, got ${shown} — this field is not a boolean switch: true/false/"true"/"yes" are rejected.`,
    });
  if (typeof raw !== "string") return reject(`${boundedShown(raw)} (${typeof raw})`);
  const text = raw.trim();
  if (text.length === 0) return { value: null };
  if (BOOLEAN_LIKE_FORK_VALUES.has(text.toLowerCase())) return reject(boundedShown(raw));
  if (text === FORK_FROM_MAIN) return { value: FORK_FROM_MAIN };
  if (text === FORK_NONE) return { value: null };
  if (SESSION_ID_SHAPE.test(text)) return { value: text };
  return reject(boundedShown(raw));
}

/**
 * 报错里的 persona **定位信息**：是哪一条角色，不是它的全部内容。
 *
 * 数组 persona 的第二项是行为描述，可以长到几万字：把它 JSON 化进一句报错里，报错就没法读了，
 * 长的还能整段挤进模型的上下文。所以数组 persona **只印角色名**；纯字符串 persona 走
 * `boundedShown`，一样有上界。两处都不能原样回显——这正是这一段被单列出来的原因。
 *
 * 条目下标是另一回事：`normalizeEntry` 一次只看得到一条条目，没有下标可用，用"第几条"定位的是
 * `duplicatePersonaProblem`（它看得到整份计划）。
 *
 * @param {string|string[]} personaValue - 已通过 personaValueOf 的值。
 * @returns {string} 有界的定位文本。
 */
function personaLabel(personaValue) {
  return Array.isArray(personaValue) ? boundedShown(personaNameOf(personaValue)) : boundedShown(personaValue);
}

/**
 * `task` 被拒时，说清**收到的是什么**。
 *
 * 为什么不是一句 "needs a task"：上面那句 `typeof raw.task === "string" ? raw.task.trim() : ""` 会
 * 把三种完全不同的输入（没写这个字段 / 写了但不是字符串 / 写了但是空白）压成同一个 `""`，
 * 于是"缺一个字段"和"值写错了类型"在旧文案里长得一模一样。模型据此只能猜，实测就猜错了方向。
 */
function taskProblem(raw) {
  if (raw === undefined) return "missing";
  if (typeof raw !== "string") return `${boundedShown(raw)} (${typeof raw})`;
  return "blank/whitespace-only";
}

/**
 * 计划里出现**重复角色**时的问题说明（没有则返回 null）。
 *
 * 为什么在写计划这一刻就拒：派发是按角色名取**第一条**匹配的条目（tools.js 的 `findIndex`），
 * 所以第二条同角色条目永远拿不到 id、status 永远停在 pending——它不会报错，只会静静地不被派发。
 * 这是"写下来的那一刻"就能判定的账，留到派发时发现就太晚了（那时主代理只看到一条没回执）。
 *
 * 位置用**下标**（0 起）：`normalizeEntry` 只看得到一条条目，这条消息比 E1-E7 多一个"第几条"的信息，
 * 而 JSON 数组里就是这个下标。
 *
 * @param {object[]} entries - 已通过 normalizeEntry 的条目。
 * @returns {string|null} 出错说明，或 null（没有重复）。
 */
export function duplicatePersonaProblem(entries) {
  const seen = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const name = personaNameOf(entries[i]?.persona);
    const first = seen.get(name);
    if (first !== undefined) {
      return `entries ${first} and ${i} both use persona ${boundedShown(name)}: a dispatch matches the first entry with that role, so entry ${i} would never be dispatched and its status would stay pending. Give each entry a distinct role.`;
    }
    seen.set(name, i);
  }
  return null;
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
  // 到这一行 persona 已经合法了，所以出错的一定是 `task`——文案必须说这个字段名，而不是把
  // persona 的字符串再引一遍（那正是旧文案的病：模型读到的"问题"在 persona 上，就跑去改 persona）。
  // persona 留在句尾当"是哪一条"的定位信息，数组 persona 只取角色名（见 personaLabel）。
  if (task.length === 0) return { error: `entry (persona ${personaLabel(personaValue)}) has an invalid \`task\` field: it is ${taskProblem(raw.task)}. \`task\` is required, and must be a non-empty string.` };
  const blacklist = Array.isArray(raw.blacklist)
    ? raw.blacklist.filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => name.trim())
    : [];
  // 保留角色的工具面是固定的（写死在派发点的分支里），条目上写的黑名单不会生效。静默忽略等于
  // 让写的人以为自己收窄了权限——这里直接拒掉并说清原因（2026-09-17 验证者实测：条目黑名单被忽略）。
  // 判定走 personaNameOf（与派发点的 personaKey 同一个取值方式）：`["slopCleaner", "x"]` 是个合法
  // persona，派发点照样把它当保留角色、发固定工具面，所以这里也必须认它——早先只比
  // `typeof === "string"`，数组形式就能把黑名单带过这道闸，然后在派发点被静默替换掉。
  // 文案的 persona 部分走 personaLabel：这道闸**新增**了数组形式这条可达路径，而数组的第二项
  // 是行为描述、可以长到几万字，原样插进引号里就等于把整段描述印进报错（见 personaLabel）。
  if (blacklist.length > 0 && PERSONAS_WITH_FIXED_TOOL_FACE.includes(personaNameOf(personaValue))) {
    return {
      error: `persona ${personaLabel(personaValue)} has a fixed tool face: a blacklist on this entry would be ignored, so it is rejected instead. Drop the blacklist field, or use [role, description] if you need to narrow a subagent's tools.`,
    };
  }
  const fork = forkValueOf(raw.fork);
  // persona 这一处也要过 personaLabel：它是 E6 的**兄弟行**，而数组 persona 的第二项能长到几万字
  // （先前只修了 E6，把这一行留下了一次 50000 字的实测）。
  if (fork.error !== undefined) return { error: `entry ${personaLabel(personaValue)}: ${fork.error}` };
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
