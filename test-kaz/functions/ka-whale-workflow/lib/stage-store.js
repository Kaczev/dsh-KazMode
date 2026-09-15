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
 * 临时文件名的**进程内序号**。
 *
 * 为什么不能只用 `pid + 毫秒`：同一个 tick 里会有**多个写指向同一个文件**——claim 监听器
 * 一次就写三处（轮次标记 + `store.setStage` 发起的游离重复写 + 旁边 await 的那次写），
 * 而它们的 `Date.now()` 极可能落在同一毫秒。于是两个写算出**同一个临时路径**：各自写进去、
 * 各自 rename，先 rename 的把临时文件搬走，后一个 rename 的源文件就不在了 → ENOENT/EPERM。
 * 砸到被 await 的那个写就是**整轮失败**（实测：修前 20 次 disk 跑挂 12 次，其中 7 次连
 * 最终文件都是错的）。
 *
 * 递增序号在进程内单调，所以"同一毫秒的并发写"绝不会共用一个临时名；跨进程由 pid 区分
 * （同时存在的进程 pid 必不相同，进程号复用只会发生在不再并发的时刻）。
 */
let tmpSeq = 0;

/** 本次写专用的临时路径：同进程内唯一，跨进程靠 pid。**原子写形状（tmp→rename）不变**。 */
function tmpPathFor(file) {
  tmpSeq += 1;
  return `${file}.${process.pid}.${Date.now()}.${tmpSeq}.tmp`;
}

/**
 * 每个阶段文件一条**进程内写队列**：同一文件的"读—改—写"必须串行，不能重叠。
 *
 * 为什么光有唯一临时名还不够（实测数据）：临时名撞车解决的是"两个写共用同一个临时文件"，
 * 但 Windows 上**两个 rename 同时落到同一个目标路径**本身就是 EPERM（与临时名无关）。
 * 隔离探针：顺序写 200 次 0 错；并发写 100 次 17~22 次 EPERM；并发读—改—写同样 18 次——
 * 而且 %TEMP% 与测试区（非 TEMP 的真实 C: 目录）一模一样，所以不是杀软或临时目录的锅。
 * 串行之后同进程内不再有重叠写；顺带把"两个会话同时读—改—写、后者覆盖前者"的丢键也一并解决
 * （读发生在上一笔写完成之后，拿到的是最新内容）。
 *
 * 队列按文件分：不同项目的写互不排队。调用顺序即队列顺序，所以同一 tick 里的
 * "先写轮次标记、再写阶段"次序不变。前一笔失败不会卡住后一笔（then(task, task)）。
 */
const writeQueues = new Map();

/** 把一次读—改—写排进该文件的队列；返回这次写自己的 promise（错误照旧抛给调用方）。 */
function serializeWrite(file, task) {
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => {},
    () => {},
  );
  writeQueues.set(file, settled);
  void settled.then(() => {
    // 队列排空就删掉，别让 Map 随项目数无限长（同一个文件才需要排队）。
    if (writeQueues.get(file) === settled) writeQueues.delete(file);
  });
  return run;
}

/** rename 覆盖目标可容忍的瞬时错误（Windows 上"目标或临时文件此刻被别人持有"都报这几个）。 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 2;

/**
 * 原子替换那一步：rename 覆盖目标，撞上瞬时占用就重试。
 *
 * 为什么光排队还不够：队列只挡住**同进程的写**，挡不住**读**。Windows 上 rename 覆盖一个
 * 正被读句柄打开的文件会直接 EPERM——实测：同一个目标上一边跑 readFile 一边 rename，
 * 300 次里 288 次 EPERM；没有读者时 300 次 0 错。而读这个文件的人就在队列之外：
 * `refresh()` 的 readStage/readRoundMarks，以及装配期的**同步** `readStageSync`（同步读没法
 * 一起排队）。所以这里重试：读窗口是微秒级，隔 2/4/6/8ms 再搬一次就过去了。
 * 次数有上限，真的搬不动（权限、磁盘）照旧把错误抛给调用方，不吞。
 */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS * attempt));
    }
  }
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
  return serializeWrite(file, async () => {
    const all = await readRaw(cwd);
    all[sessionId] = String(stage);
    await mkdir(dirname(file), { recursive: true });
    const tmp = tmpPathFor(file);
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, file);
    return true;
  });
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
      const count = value?.count;
      if (typeof count === "number" && Number.isFinite(count)) out[key] = { count };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写入某个对话的**轮次计数**（读—改—写）。缺失时不动文件，返回 false。
 *
 * 存的是"第几条真人用户消息"，不是"最后数过的 seq"：
 * 计数由 `agent/inbox/claimed` 在**当轮、assemble 之前** +1，所以不需要靠事件流重建。
 * 旧数据里的 `lastRoundSeq` 读不到了没关系——那种会话会从当前这一条重新起算（顶多错一轮）。
 */
export async function writeRoundMark(cwd, sessionId, count) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (typeof count !== "number" || !Number.isFinite(count)) return false;
  const file = stageFile(cwd);
  // 与 writeStage 排**同一条**队列：两者都动同一个文件，必须串行。
  return serializeWrite(file, async () => {
    const all = await readRaw(cwd);
    const marks = all.__rounds !== null && typeof all.__rounds === "object" && !Array.isArray(all.__rounds) ? all.__rounds : {};
    marks[sessionId] = { count };
    all.__rounds = marks;
    await mkdir(dirname(file), { recursive: true });
    const tmp = tmpPathFor(file);
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await renameWithRetry(tmp, file);
    return true;
  });
}
