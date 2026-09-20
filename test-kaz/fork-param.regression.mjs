// ka-whale-workflow —— fork 参数的回归测试（跑法：本目录下 node fork-param.regression.mjs）
//
// 为什么有这个文件：`fork` 的旧毛病是**静默退化**——模型写 `fork: "true"` 时它一路活到派发点，
// 被当成一个永远找不到的会话 id，于是子代理全新开始、回执照样写 "forked from"，模型什么都学不到。
// 这种毛病不会被语法检查抓住，也不会自己复发成报错，所以必须用测试钉住"值被拒"和"回执不撒谎"。
//
// 覆盖三层，各测各的单一职责：
//   1. arrangement.js  forkValueOf —— 写安排时的形状校验（布尔不是合法值）
//   2. fork-provider.js resolveForkTarget —— 解析成"这次派发到底用什么"（none / target / fallback）
//   3. fork-provider.js completedTurnPrefix / createKazForkProvider —— 种子规则与 provider 行为
// 第 3 层要的是"源会话没有 turn/end 时种子里一个事件都没有"，那是实测里让 fork 白干的真正原因，
// 光测解析层会漏掉它。
//
// DSH_HOME 指向临时目录，测试因此不碰任何活 home：
// `writeArrangement` 在没有 cwd 时退回 `process.env.DSH_HOME ?? <home>/.dsh`（arrangement.js 的
// arrangementsDir），而本文件的替身给的曾经是空 cwd——于是每跑一次就往**主 home** 的
// storages/arrangements 写一个 `session-main.json`。那是一次测试改了活环境的账（HEAD 的 4f 同样
// 如此，属于既有毛病，不是本次改动引入的）。
//
// **它为什么有效，以及它脆在哪儿**（先前这里的说法是错的，改对）：ESM 的 `import` 会被提升到
// 模块顶部执行，所以"写在 import 之前"这件事本身**没有**任何作用——文件顶上这几行赋值与 import
// 的先后由运行时决定，不是由行号决定。真正让它成立的是：`arrangementsDir()` 在**被调用的那一刻**
// 才读 `process.env.DSH_HOME`，而所有写到盘上的调用都发生在模块求值之后。也就是说这是一条
// **求值时机**上的依赖，不是一条位置上的依赖。
// 会把它弄坏的做法只有一种：把那次 env 读取**提升到模块作用域**变成常量
// （`const HOME = process.env.DSH_HOME ?? …`）。那时它在 import 期间就固化成改动前的值，
// 测试会静默地重新开始写主 home——而且套件照样全绿。别那么改。
//
// 导入本身不受影响：`@deepseek-ai/*` 按本文件所在目录（预设行里的 node_modules）解析，与 DSH_HOME 无关。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 本套件在临时目录里占用的名字前缀：只有这一族目录会被扫描收走。 */
const SWEEP_PREFIX = "kaz-fork-regression-";

/**
 * 临时 home 的清理。**实测过的行为，不是设计意图**（2026-09-20，Windows / Node 24）：
 *
 * | 结束方式 | 谁收的 | 结果 |
 * |---|---|---|
 * | 正常跑完 / `process.exit()` / 未捕获异常 | 下面的 `exit` 钩子（同步，`rmSync` 同步） | 收掉 |
 * | SIGTERM / SIGINT（含控制台 Ctrl+C） | **没有人** | 靠下次运行的扫描 |
 *
 * 为什么信号那两条要靠扫描，而不是装 `process.on("SIGINT"/"SIGTERM")`：本机实测，Windows 上
 * 这两个信号**根本不会送到钩子**——`process.kill(process.pid, "SIGINT")` 直接终止进程，连
 * `exit` 钩子都不跑（探针文件一个都没写出来，退出码 1）。装了钩子也只是看起来有防护。
 * 也就是说：**"进程被中断"这一类只能靠扫描兜底**，不是"再装个钩子就行"。
 *
 * 扫描按**目录年龄**取舍（默认 5 分钟），而年龄取的是"这个目录**以及它全部内容**里最新的那个
 * mtime"，不是目录自己的 mtime。为什么必须连内容一起看——本机实测（2026-09-20，NTFS / Node 24）：
 *   * 在目录里**新建一个条目**：目录自己的 mtime 会跟着变（16:20:48 → 16:21:48）；
 *   * **改写一个已经存在的文件**：目录自己的 mtime **不变**（16:20:48 → 16:20:48），
 *     变的只有那个文件自己的 mtime。
 * 也就是说目录 mtime 是"最后一次往里加东西"，不是"最后一次活动"。只看它的话，一个"一开始把文件都
 * 建好、之后只往里写"的运行会**越跑越显老**——那正是"按年龄淘汰"最容易误杀的形状。取内容的最大
 * mtime 就把这种情况盖住了（实测两者可以差出 60 秒，量级随运行时长增长）。
 *
 * 只删目录：名字命中前缀、但不是目录的条目会**被跳过**，因为 `rmSync` 的 recursive 只对目录有意义，
 * 而一个同名**文件**不可能是本套件建的（`mkdtempSync` 只建目录）——真出现就说明是别的东西占了名字，
 * 那更不该删。跳过的数量会打进启动那行输出，好在日志里看得见，而不是静默略过。
 *
 * 代价：刚被掐掉的目录要等到下次运行才被收走。
 */
function sweepOrphanedTempHomes() {
  const prefix = SWEEP_PREFIX;
  const cutoff = Date.now() - 5 * 60 * 1000;
  let removed = 0;
  let skipped = 0;

  /** 这个目录**以及它全部内容**里最新的 mtime：目录 mtime 只反映"最后一次加东西"。 */
  const newestMtime = (path) => {
    let newest = statSync(path).mtimeMs;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      try {
        newest = Math.max(newest, entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs);
      } catch {
        // 遍历中途被删掉／读不到：那个条目不参与判断，别的照旧。
      }
    }
    return newest;
  };

  try {
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix)) continue;
      const path = join(tmpdir(), entry.name);
      try {
        if (!entry.isDirectory()) {
          skipped += 1;
          continue;
        }
        if (newestMtime(path) > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      } catch {
        // 单个目录删不掉不影响别的，也不影响本次运行。
      }
    }
  } catch {
    // tmpdir 读不了就直接跳过；清理永远不许影响测试结论。
  }
  return { removed, skipped };
}

const sweptBefore = sweepOrphanedTempHomes();
const TEST_HOME = mkdtempSync(join(tmpdir(), "kaz-fork-regression-"));
process.env.DSH_HOME = TEST_HOME;

if (!TEST_HOME.startsWith(tmpdir())) {
  throw new Error(`refusing to run: temp home is not under tmpdir(): ${TEST_HOME}`);
}

/**
 * 清理失败**不许**影响测试结论：套件的判决来自断言，不来自这里。失败写在 stderr（保持 stdout
 * 只有结果正文），成功那条写在最后一行 stdout 上（见文件末尾）。
 */
let tempHomeRemoved = false;
function removeTempHome() {
  if (tempHomeRemoved) return;
  tempHomeRemoved = true;
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    process.stderr.write(`[kaz-fork-regression] temp home not removed: ${TEST_HOME}\n`);
  }
}
process.on("exit", removeTempHome);

import { arrangementFile, arrangementsDir, boundedShown, duplicatePersonaProblem, forkValueOf, normalizeEntry, patchEntryAt, readArrangement, ERROR_ECHO_MAX_CHARS, FORK_FROM_MAIN } from "./functions/ka-whale-workflow/lib/arrangement.js";
import { KAZ_FORK_PROVIDER, completedTurnPrefix, createKazForkProvider, noteForkSource, resolveForkTarget } from "./functions/ka-whale-workflow/lib/fork-provider.js";
import { getArrangementTool, kaSubWhaleTool, whaleReportTool, writeArrangementTool } from "./functions/ka-whale-workflow/lib/tools.js";

/** 替身会话的 cwd：指到临时 home 里，测试因此不写到任何活 home。 */
const TEST_CWD = join(TEST_HOME, "probe-ws");

let failed = 0;
const results = [];

function check(name, condition, detail) {
  if (condition) {
    results.push(`PASS  ${name}`);
  } else {
    failed += 1;
    results.push(`FAIL  ${name}${detail !== undefined ? `  <-- ${detail}` : ""}`);
  }
}

const LIVE_ID = "11111111-2222-3333-4444-555555555555";

/** 只实现被测代码真正会用的那一面：`get(id)` 返回活体 agent 或 undefined。 */
function registry(entries) {
  const table = new Map(Object.entries(entries));
  return {
    get: (id) => table.get(id),
    has: (id) => table.has(id),
    ids: () => [...table.keys()],
  };
}

/** 派发者自己的会话替身：只在测"源 = 派发者"那条路上用到。 */
const dispatcherSession = { id: "session-main", snapshotEvents: () => [] };

// ── 1. 写安排：`fork` 的形状 ───────────────────────────────────────────────────
{
  // 1a. 这条是本次修复的起点：模型把字段当布尔开关写。
  for (const bad of [true, false, 1, 0, [], {}]) {
    const got = forkValueOf(bad);
    check(`1a. fork=${JSON.stringify(bad)} (${typeof bad}) 被拒`, got.error !== undefined, `got ${JSON.stringify(got)}`);
  }

  // 1b. 同一种误用写成字符串也要拒——它们在字典里"看起来像是非空字符串"。
  for (const bad of ["true", "false", "yes", "no", "on", "off", "TRUE", "True", "main session", "session main", "a b"]) {
    const got = forkValueOf(bad);
    check(`1b. fork=${JSON.stringify(bad)} 被拒`, got.error !== undefined, `got ${JSON.stringify(got)}`);
  }

  // 1c. "不 fork" 只有三种写法：没写、null、空串——它们不是"写错了"。
  for (const empty of [undefined, null, "", "   "]) {
    const got = forkValueOf(empty);
    check(`1c. fork=${JSON.stringify(empty)} 归一成"不 fork"`, got.error === undefined && got.value === null, `got ${JSON.stringify(got)}`);
  }

  // 1c'. 而 `false` 是**写错的值**，不是"不 fork"：字段名像开关正是不该给开关留后门的原因，
  // 认掉 `false` 就等于承认"可以当布尔写"，`"true"` 会跟着一起被当成合法。
  check("1c'. fork=false 也报错（不给布尔留后门）", forkValueOf(false).error !== undefined, JSON.stringify(forkValueOf(false)));

  // 1c''. 显式的 `"none"` = 不 fork，而且**与不写这个字段存成同一种条目**（都是 null）。
  // 为什么单列：不给它含义时，`"none"` 形状上是个合法会话 id，会被当成一个查不到的会话投递，
  // 回执还印一句误导的话——看起来像"我说了 none 所以没 fork"，实际含义完全不同。
  {
    const got = forkValueOf("none");
    check('1c2. fork="none" 归一成"不 fork"', got.error === undefined && got.value === null, JSON.stringify(got));
    check('1c2. fork="  none  " 裁空白后同上', forkValueOf("  none  ").value === null);
    const entry = normalizeEntry({ persona: ["worker", "does work"], task: "t", fork: "none" });
    check('1c2. fork="none" 的条目里没有 fork 字段（与不写等价）', entry.error === undefined && !("fork" in entry.entry), JSON.stringify(entry));
  }

  // 1d. 两个合法值：字面 "main"（大小写敏感，前后空白裁掉）与会话 id 形状。
  check('1d. fork="main" 合法', forkValueOf(FORK_FROM_MAIN).value === "main");
  check('1d. fork="  main  " 裁空白后合法', forkValueOf("  main  ").value === "main");
  check("1d. fork=<会话 id> 合法", forkValueOf(LIVE_ID).value === LIVE_ID);

  // 1e. 错误正文要**说清允许什么**，否则模型只会换个错值再来一次。
  const message = forkValueOf(true).error ?? "";
  check("1e. 拒绝正文点明这不是布尔开关", /not a boolean/i.test(message), message);
  check('1e. 拒绝正文给出 "main" 这条出路', /"main"/.test(message), message);

  // 1f. 经 normalizeEntry 走一遍：拒错、保留对的值、不写 fork 时不留字段。
  const ok = normalizeEntry({ persona: ["worker", "does work"], task: "t", fork: LIVE_ID });
  check("1f. normalizeEntry 保留合法 fork", ok.error === undefined && ok.entry.fork === LIVE_ID, JSON.stringify(ok));
  const rejected = normalizeEntry({ persona: ["worker", "does work"], task: "t", fork: true });
  check("1f. normalizeEntry 拒绝布尔 fork", rejected.error !== undefined, JSON.stringify(rejected));
  check("1f. 拒绝正文带上 persona，便于定位", /worker/.test(rejected.error ?? ""), rejected.error);
  const absent = normalizeEntry({ persona: ["worker", "does work"], task: "t" });
  check("1f. 不写 fork 时条目里没有这个字段", absent.error === undefined && !("fork" in absent.entry), JSON.stringify(absent));
}

// ── 2. 派发：`fork` 解析成什么 ─────────────────────────────────────────────────
{
  const empty = registry({});
  const none = resolveForkTarget(undefined, empty.get);
  check('2. 没写 fork → kind "none"（回执一个字都不提）', none.kind === "none", JSON.stringify(none));

  const main = resolveForkTarget("main", empty.get);
  check('2. fork="main" → 切 kaz-fork，源 = 派发者自己', main.kind === "target" && main.source === null, JSON.stringify(main));

  const live = registry({ [LIVE_ID]: { id: LIVE_ID, status: "idle" } });
  const target = resolveForkTarget(LIVE_ID, live.get);
  check("2. 目标活着 → 把它的会话 id 交给 provider", target.kind === "target" && target.source === LIVE_ID, JSON.stringify(target));

  // 2d. 这条最关键：目标"说什么都解析不到"时**不能说成 fork 成功**。
  const gone = resolveForkTarget(LIVE_ID, registry({}).get);
  check('2. 目标不是活会话 → kind "fallback"（不是 none）', gone.kind === "fallback", JSON.stringify(gone));
  check("2. fallback 记得住原目标名（回执要报出来）", gone.target === LIVE_ID, JSON.stringify(gone));
  check("2. fallback 不返回 source（没有可继承的源）", gone.source === undefined, JSON.stringify(gone));

  // 2e. 真派发时用的那个 ctx.get("agents") 可能整个缺失——解析层不许抛。
  const noRegistry = resolveForkTarget(LIVE_ID, undefined);
  check("2. agents 服务拿不到：解析成 fallback 而不是抛错", noRegistry.kind === "fallback", JSON.stringify(noRegistry));
}

// ── 3. 种子规则与 provider 行为 ───────────────────────────────────────────────
{
  const events = [
    { type: "turn/start", seq: 0 },
    { type: "step/start", seq: 1 },
    { type: "step/end", seq: 2 },
    { type: "turn/end", seq: 3 },
    { type: "user/message", seq: 4 },
    { type: "step/start", seq: 5 },
  ];
  const prefix = completedTurnPrefix({ snapshotEvents: () => events });
  check("3. 前缀切在最后一个 turn/end（含）", prefix.length === 4 && prefix[3].type === "turn/end", `len=${prefix.length}`);

  // 3b. 没有闭合回合 = 前缀为空。派发发生在回合中途时必然是这个状态，也是实测里 fork 白干的那一格。
  const openTurn = [{ type: "turn/start", seq: 0 }, { type: "step/end", seq: 1 }, { type: "step/start", seq: 2 }];
  check(
    "3. 源会话没有 turn/end：前缀为空（子代理继承不到任何历史）",
    completedTurnPrefix({ snapshotEvents: () => openTurn }).length === 0,
  );

  // 3b'. 但"没有 turn/end"只描述**当前这个回合**，不等于"永远为空"：已经闭合过回合的源，
  // 前缀就是它那些闭合回合——所以 fork 在"派生会话"里是能真正给出历史的（2026-09-18 那个
  // doc-updater 子会话 `isSeeded:true, inheritedEventCount:175` 就是这么来的）。这一条把机制钉住，
  // 防止"fork 永远继承不到东西"这个过头的结论再冒出来。
  const resumed = [
    { type: "permission/preset", seq: 0 },
    { type: "turn/start", seq: 1 },
    { type: "step/end", seq: 2 },
    { type: "turn/end", seq: 3 },
    { type: "user/message", seq: 4 },
    { type: "turn/start", seq: 5 },
    { type: "step/start", seq: 6 },
  ];
  const resumedPrefix = completedTurnPrefix({ snapshotEvents: () => resumed });
  check(
    "3b'. 源闭合过回合：前缀取到最后一个 turn/end（含），后面的在飞回合不算",
    resumedPrefix.length === 4 && resumedPrefix[3].type === "turn/end",
    `len=${resumedPrefix.length}`,
  );
  const resumedProvider = createKazForkProvider({ get: (name) => (name === "agents" ? registry({}) : undefined) });
  noteForkSource("child-resumed", "");
  const resumedPrepared = await resumedProvider.prepareContinuable({
    sessionId: "child-resumed",
    parent: { session: { id: "session-main", snapshotEvents: () => resumed } },
  });
  check(
    "3b'. fork 指向一个闭合过回合的源：种子真的交给 provider（这条就是 2026-09-18 那次成功的机制）",
    Array.isArray(resumedPrepared.seed) && resumedPrepared.seed.length === resumedPrefix.length,
    JSON.stringify(resumedPrepared.seed?.length),
  );

  // 3c. 拿不到会话：不许抛，按"没有前缀"处理。
  check("3. session 为 undefined：不抛、返回空前缀", completedTurnPrefix(undefined).length === 0);
  check("3. session 没有 snapshotEvents：不抛、返回空前缀", completedTurnPrefix({}).length === 0);

  // 3d. provider 本体：注册名、能力、以及"空前缀时**不能**给出 seed 键"。
  // 空前缀却给出 `seed: []` 会让平台把子会话当成"有继承前缀"（`prepared.seed !== void 0`），
  // 那与实测到的 isSeeded:false 行为不符。
  const ctx = { get: (name) => (name === "agents" ? registry({}) : undefined) };
  const provider = createKazForkProvider(ctx);
  check("3. provider 名字就是 KAZ_FORK_PROVIDER", provider.name === KAZ_FORK_PROVIDER, provider.name);
  check("3. provider 声明继承了父上下文", provider.inheritsParentContext === true);
  check(
    "3. 空前缀：prepareContinuable 返回的对象里没有 seed 键",
    (await provider.prepareContinuable({ sessionId: "child-1", parent: { session: dispatcherSession } })).seed === undefined,
  );

  // 3e. 有闭合回合的源 + 登记过的 id：种子必须真的落到 provider 手里（这是测试里唯一能证明
  // "非空种子会被交出去"的地方——实测的六个探针全是负例，正例至今没在真 harness 上出现过）。
  const closedEvents = [...openTurn, { type: "turn/end", seq: 3 }];
  const sourceSession = { id: LIVE_ID, snapshotEvents: () => closedEvents };
  const seededCtx = { get: (name) => (name === "agents" ? registry({ [LIVE_ID]: { id: LIVE_ID, status: "idle", session: sourceSession } }) : undefined) };
  const seeded = createKazForkProvider(seededCtx);
  noteForkSource("child-2", LIVE_ID);
  const prepared = await seeded.prepareContinuable({ sessionId: "child-2", parent: { session: dispatcherSession } });
  check("3. 有闭合回合的源：种子被交出去，长度等于前缀", Array.isArray(prepared.seed) && prepared.seed.length === closedEvents.length, JSON.stringify(prepared.seed?.length));

  // 3f. 登记成"派发者自己"（`"main"` 与 fallback 都走这条）：种子取自派发者。
  const mainCtx = { get: (name) => (name === "agents" ? registry({}) : undefined) };
  const mainProvider = createKazForkProvider(mainCtx);
  noteForkSource("child-3", "");
  const mainPrepared = await mainProvider.prepareContinuable({ sessionId: "child-3", parent: { session: { id: "session-main", snapshotEvents: () => closedEvents } } });
  check("3. 登记成空串：种子取自派发者自己的会话", Array.isArray(mainPrepared.seed) && mainPrepared.seed.length === closedEvents.length, JSON.stringify(mainPrepared.seed?.length));

  // 3g. 登记的是外部 id、但注册表里没有它：`undefined` 源 → 空前缀 → 不给 seed。
  // （故意不退回派发者：那个决定归 resolveForkTarget，provider 这里退一次就成了第二处决定点。）
  const ghostProvider = createKazForkProvider({ get: (name) => (name === "agents" ? registry({}) : undefined) });
  noteForkSource("child-4", "99999999-0000-0000-0000-000000000000");
  const ghost = await ghostProvider.prepareContinuable({ sessionId: "child-4", parent: { session: { id: "session-main", snapshotEvents: () => closedEvents } } });
  check("3. 登记的源已不在注册表：不借派发者的日志顶替", ghost.seed === undefined, JSON.stringify(ghost));
}

// ── 4. 派发点整条路：`ka_sub_whale` 到底调了谁、回了什么 ────────────────────────
//
// 前三层各测一个纯函数，这一层把整条路串起来跑：真正做决定的代码在 `kaSubWhaleTool.execute`
// 里（选 provider、选源、写回执），只测纯函数会漏掉"回执怎么讲"和"哪个 provider 被传下去"。
{
  const DISPATCHER_ID = "session-main";
  const roleName = "probe-role";

  /** 一个够用的 ctx + store + subagents 替身：只实现被测代码真正会用的那一面。 */
  function harness({ agents = {}, children = [], sendMessageFails = false } = {}) {
    const calls = { startContinuable: [], sendMessage: [], written: [] };
    const agentTable = new Map(Object.entries(agents));
    const ctx = {
      logger: { debug: () => {}, warn: () => {}, info: () => {} },
      get: (name) => {
        if (name === "agents") return { get: (id) => agentTable.get(id) };
        if (name === "tools") return { schemas: () => [{ name: "read" }, { name: "pwsh" }] };
        if (name === "subagents") {
          return {
            listChildren: async () => children,
            sendMessage: async (sender, targetId, content) => {
              calls.sendMessage.push({ targetId, content });
              if (sendMessageFails) throw new Error("target is gone");
            },
            startContinuable: async (spec) => {
              calls.startContinuable.push(spec);
              return { childId: spec.childId };
            },
          };
        }
        return undefined;
      },
    };
    const entries = [{ persona: [roleName, "does work"], blacklist: [], task: "do the thing", id: "", status: "pending", summary: "" }];
    const store = {
      getStage: () => "idle",
      loadEntries: async () => entries,
      setEntries: (_sessionId, next) => {
        entries.length = 0;
        entries.push(...next);
      },
    };
    const exec = {
      agent: { id: DISPATCHER_ID, status: "running", session: { id: DISPATCHER_ID, header: { cwd: TEST_CWD } } },
      signal: new AbortController().signal,
    };
    return { ctx, store, exec, entries, calls };
  }

  // 4a. `fork: "main"` → 切 kaz-fork、源是派发者自己、回执说"forked from your conversation"。
  {
    const h = harness();
    h.entries[0].fork = FORK_FROM_MAIN;
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4a. fork=main：真的切到 kaz-fork", h.calls.startContinuable[0]?.provider === KAZ_FORK_PROVIDER, JSON.stringify(h.calls.startContinuable[0]?.provider));
    check("4a. fork=main：请求的 parent 就是派发者", h.calls.startContinuable[0]?.request?.parent?.id === DISPATCHER_ID);
    check("4a. fork=main：回执说明了从哪儿 fork", /forked from your conversation/.test(out.message), out.message);
    check("4a. fork=main：结果是成功", out.ok === true, JSON.stringify(out));
  }

  // 4b. 目标已不是活会话 → **不能**说成 fork 成功，而且不许退回 kaz-fork 假装继承。
  {
    const h = harness();
    h.entries[0].fork = "11111111-2222-3333-4444-555555555555";
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4b. 目标失效：provider 保持 spawn（没有源可以继承）", h.calls.startContinuable[0]?.provider === "spawn", JSON.stringify(h.calls.startContinuable[0]?.provider));
    check("4b. 目标失效：回执明说退回自己的会话", /is not a live session/.test(out.message), out.message);
    check("4b. 目标失效：回执明说子代理**没有**继承任何历史", /no inherited history/.test(out.message), out.message);
    check("4b. 目标失效：回执不再谎称 forked from", !/forked from/i.test(out.message), out.message);
  }

  // 4c. 没写 fork → 全新开始，回执里不该出现任何 fork 的字眼。
  {
    const h = harness();
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4c. 没写 fork：provider 是 spawn", h.calls.startContinuable[0]?.provider === "spawn");
    check("4c. 没写 fork：回执不提 fork", !/fork/i.test(out.message), out.message);
  }

  // 4d. 复用分支：fork 在这个分支里从来不会被消费，回执必须自己说一句。
  {
    const reusableId = "77777777-8888-9999-0000-111111111111";
    const h = harness({ children: [{ kind: "child", mode: "continuable", label: roleName, id: reusableId }] });
    h.entries[0].fork = FORK_FROM_MAIN;
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4d. 复用：走了 sendMessage 而不是新开", h.calls.sendMessage.length === 1 && h.calls.startContinuable.length === 0, JSON.stringify(h.calls.sendMessage.length));
    check("4d. 复用：回执明说 fork 目标没被应用", /NOT applied/.test(out.message), out.message);
  }

  // 4e. 没写 fork 的复用：不多嘴。
  {
    const reusableId = "77777777-8888-9999-0000-111111111112";
    const h = harness({ children: [{ kind: "child", mode: "continuable", label: roleName, id: reusableId }] });
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4e. 复用且没写 fork：回执不提 fork", !/fork/i.test(out.message), out.message);
  }

  // 4e'. 条目上有 `fork` 这个键、值是 `undefined`（规划里写了又清掉的那一条，就会长这样）。
  // 它必须与"根本没有这个键"同一条路：不切 provider、回执里一个 fork 字眼都不出现。
  // 为什么单列：旧代码判的是"条目有没有 fork 属性"，于是这种条目会印出
  // `the fork target "undefined" was NOT applied` —— 2026-09-19 实测在真环境里见过这一句
  // （当时跑的是修复前的代码），所以它是真的会冒出来的形态，不是假想。
  {
    const reusableId = "77777777-8888-9999-0000-111111111113";
    const h = harness({ children: [{ kind: "child", mode: "continuable", label: roleName, id: reusableId }] });
    h.entries[0].fork = undefined;
    const hasKey = Object.hasOwn(h.entries[0], "fork");
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4e'. fork 键在但值是 undefined：照旧复用", hasKey && h.calls.sendMessage.length === 1, JSON.stringify(h.calls.sendMessage.length));
    check("4e'. fork=undefined 的复用：回执不提 fork、更不许印出 \"undefined\"", !/fork/i.test(out.message) && !/undefined/.test(out.message), out.message);
  }

  // 4e''. 全新开始那条路也一样：`fork: undefined` 不得让 provider 切到 kaz-fork。
  {
    const h = harness();
    h.entries[0].fork = undefined;
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: roleName }, h.exec);
    check("4e''. fork=undefined 且不复用：provider 是 spawn", h.calls.startContinuable[0]?.provider === "spawn", JSON.stringify(h.calls.startContinuable[0]?.provider));
    check("4e''. fork=undefined 且不复用：回执不提 fork", !/fork/i.test(out.message), out.message);
  }

  // 4f. 写安排这一层：布尔 fork 在**写下来的那一刻**就被拒，不会留到派发点。
  {
    const h = harness();
    const writeStore = { getStage: () => "arrange_agent", loadEntries: async () => h.entries, setEntries: () => {} };
    const tool = writeArrangementTool({ store: writeStore });
    const bad = await tool.execute({ entries: [{ persona: [roleName, "does work"], task: "t", fork: true }] }, h.exec);
    check("4f. write_arrangement 拒绝 fork:true", bad.ok === false, JSON.stringify(bad));
    check("4f. 拒绝正文点明这不是布尔开关", /boolean switch/.test(bad.message), bad.message);
    const good = await tool.execute({ entries: [{ persona: [roleName, "does work"], task: "t", fork: FORK_FROM_MAIN }] }, h.exec);
    check("4f. write_arrangement 接受 fork:\"main\"", good.ok === true, JSON.stringify(good));
  }
}

// ── 5. 条目形状被拒（E1-E7）+ 重复角色 + 保留角色数组形式的黑名单 ────────────────
//
// 为什么单列一层：到 8.9.4 为止这个文件每一条喂进去的条目形状都是对的——被换的字段**只有 `fork`**
// （1f、4e'、4e''、4f），而 E1-E6 一条断言都没有。于是"条目形状的文案"可以随便改而套件照样全绿，
// E5 那句 `entry <persona> needs a task` 就是这么活到实测里去的：它引的是 persona，出错的是 task，
// 模型读到以后跑去改 persona。这一层把每条文案**按整句**钉住（不是正则），改一个字就红。
//
// 标签沿用 2026-09-20 那次排查的编号（E1-E7 = arrangement.js 里按求值顺序的那七种形状拒绝），
// 另外 T3/T4 是 tools.js 外层的两条。
{
  /** 只给被测代码真正会用的那一面：阶段、账本、写回。 */
  function writeHarness(stage = "arrange_agent") {
    let entries = [];
    const store = {
      getStage: () => stage,
      loadEntries: async () => entries,
      setEntries: (_sessionId, next) => {
        entries = next;
      },
    };
    const exec = { agent: { id: "session-main", status: "running", session: { id: "session-main", header: { cwd: TEST_CWD } } } };
    return { tool: writeArrangementTool({ store }), exec, current: () => entries };
  }

  const T = "t";

  // 5a. E1：条目根本不是对象。
  {
    const h = writeHarness();
    const out = await h.tool.execute({ entries: [null] }, h.exec);
    check("5a. E1 整句", out.message === "each entry must be an object", JSON.stringify(out.message));
  }

  // 5b. E2：字符串 persona 不是保留值。E4：persona 根本不是字符串也不是数组。E3：数组形状不对。
  {
    const h = writeHarness();
    const e2 = await h.tool.execute({ entries: [{ persona: "worker", task: T }] }, h.exec);
    check(
      "5b. E2 整句（并给出三条出路）",
      e2.message === 'persona "worker" is not allowed — use "main", "memoryMaintainer", "slopCleaner", or [role, description]',
      JSON.stringify(e2.message),
    );
    const e4 = await h.tool.execute({ entries: [{ persona: 7, task: T }] }, h.exec);
    check(
      "5b. E4 整句",
      e4.message === 'persona must be "main", "memoryMaintainer", "slopCleaner", or [role, description]',
      JSON.stringify(e4.message),
    );
    const e3 = await h.tool.execute({ entries: [{ persona: ["solo"], task: T }] }, h.exec);
    check("5b. E3 整句", e3.message === "persona array must be exactly [role, description] — two non-empty strings", JSON.stringify(e3.message));
  }

  // 5c. E5 改版：必须**点名 task**，说清收到的是什么，并且 persona 只当定位信息用。
  // 每一条都按整句钉：三种输入（没写 / 不是字符串 / 空白）在旧文案里长得一模一样，正是它猜错方向的原因。
  {
    const cases = [
      ["没写这个字段", { persona: ["worker", "does work"] }, 'entry (persona "worker") has an invalid `task` field: it is missing. `task` is required, and must be a non-empty string.'],
      ["写了但不是字符串（数字）", { persona: ["worker", "does work"], task: 42 }, 'entry (persona "worker") has an invalid `task` field: it is 42 (number). `task` is required, and must be a non-empty string.'],
      ["写了但不是字符串（对象）", { persona: ["worker", "does work"], task: {} }, 'entry (persona "worker") has an invalid `task` field: it is {} (object). `task` is required, and must be a non-empty string.'],
      ["写了但是空白", { persona: ["worker", "does work"], task: "   " }, 'entry (persona "worker") has an invalid `task` field: it is blank/whitespace-only. `task` is required, and must be a non-empty string.'],
      ["纯字符串 persona + 没写 task", { persona: "memoryMaintainer" }, 'entry (persona "memoryMaintainer") has an invalid `task` field: it is missing. `task` is required, and must be a non-empty string.'],
    ];
    for (const [label, raw, exact] of cases) {
      const got = normalizeEntry(raw).error ?? "";
      check(`5c. E5 整句（${label}）`, got === exact, JSON.stringify(got));
    }

    // 5c'. 三种输入必须**互不相同**——否则"说清收到的是什么"这句话就没落地。
    const missing = normalizeEntry({ persona: ["worker", "d"] }).error;
    const nonString = normalizeEntry({ persona: ["worker", "d"], task: 42 }).error;
    const blank = normalizeEntry({ persona: ["worker", "d"], task: " " }).error;
    check("5c'. 缺失 / 类型错 / 空白 三句各不相同", new Set([missing, nonString, blank]).size === 3, `${missing} | ${nonString} | ${blank}`);

    // 5c''. persona 只能是定位信息：数组 persona 不许把整条数组（含行为描述）倒进文案里。
    // 旧文案正是 `entry ${JSON.stringify(personaValue)} needs a task`——描述有多长，报错就有多长。
    const entry5 = normalizeEntry({ persona: ["fact-checker", "A VERY LONG BEHAVIOUR DESCRIPTION ".repeat(20)] });
    check("5c''. 数组 persona 只印角色名", /persona "fact-checker"/.test(entry5.error ?? ""), entry5.error);
    check("5c''. 数组 persona 的行为描述不进文案", !/VERY LONG BEHAVIOUR/.test(entry5.error ?? ""), entry5.error);
    check("5c''. 点名字段是 task", /invalid `task` field/.test(entry5.error ?? ""), entry5.error);
  }

  // 5d. E6 扩到数组形式：`["memoryMaintainer", "x"]` / `["slopCleaner", "x"]` 也能把黑名单带过旧闸。
  // 旧闸只比 `typeof personaValue === "string"`，于是这两种写法在写计划时合法，到派发点却被
  // 静默换成固定工具面——模型以为自己收窄了权限。现在两种形式都拒。
  // 文案的 persona 部分改走 personaLabel：**这道闸新增了数组形式这条可达路径**，而数组第二项是
  // 行为描述、可以长到几万字，原样插进引号里就等于把整段描述印进报错（这是审查实测出来的缺陷：
  // 5400 字的描述曾让这条报错变成 5616 字）。所以数组形式只印角色名。
  {
    const tail = " has a fixed tool face: a blacklist on this entry would be ignored, so it is rejected instead. Drop the blacklist field, or use [role, description] if you need to narrow a subagent's tools.";
    const arrayKeeper = normalizeEntry({ persona: ["memoryMaintainer", "x"], blacklist: ["edit"], task: T });
    check(
      "5d. E6 数组形式（memoryMaintainer）整句，只印角色名",
      arrayKeeper.error === `persona "memoryMaintainer"${tail}`,
      JSON.stringify(arrayKeeper.error),
    );
    const arrayCleaner = normalizeEntry({ persona: ["slopCleaner", "x"], blacklist: ["edit"], task: T });
    check(
      "5d. E6 数组形式（slopCleaner）整句，只印角色名",
      arrayCleaner.error === `persona "slopCleaner"${tail}`,
      JSON.stringify(arrayCleaner.error),
    );
    check(
      "5d. E6 纯字符串形式不变",
      normalizeEntry({ persona: "memoryMaintainer", blacklist: ["edit"], task: T }).error === `persona "memoryMaintainer"${tail}`,
      JSON.stringify(normalizeEntry({ persona: "memoryMaintainer", blacklist: ["edit"], task: T }).error),
    );
    // 描述**一个字都不许**进文案：它就是审查实测里把报错撑到 5616 字的那一段。
    check("5d. E6 数组第二项（行为描述）不进文案", !/does work|XXXX|keeps memory/.test(arrayKeeper.error ?? ""), arrayKeeper.error);
    // 普通角色的数组 persona 带黑名单照旧合法：闸只针对固定工具面的那两个保留角色。
    const normal = normalizeEntry({ persona: ["worker", "does work"], blacklist: ["edit"], task: T });
    check("5d. 普通角色 + 黑名单仍然合法", normal.error === undefined && normal.entry.blacklist[0] === "edit", JSON.stringify(normal));
  }

  // 5e. E7 整句（含 persona 定位信息），三种错值各一条。骨架仍是 `entry <persona>:`，
  // 但 persona 现在走 personaLabel（只印角色名、且有界）——这一行是 E6 的兄弟行，先前漏了它，
  // 于是 `["r", <50k 描述>] + 坏 fork` 会印出 50,222 字（见 5n）。
  {
    const prefix = 'entry "worker": fork must be "main" (inherit your own conversation), "none" (start a fresh subagent), or a subagent session id, got ';
    const tail = ' — this field is not a boolean switch: true/false/"true"/"yes" are rejected.';
    for (const raw of [true, "yes", 0, []]) {
      const got = normalizeEntry({ persona: ["worker", "does work"], task: T, fork: raw }).error ?? "";
      const shown = typeof raw === "string" ? JSON.stringify(raw) : `${JSON.stringify(raw)} (${typeof raw})`;
      check(`5e. E7 整句（fork=${JSON.stringify(raw)}）`, got === `${prefix}${shown}${tail}`, JSON.stringify(got));
    }
  }

  // 5f. 空 entries：T3。以前只有 4f 间接碰到写安排这一层，没有任何一条断言过这句话。
  {
    const h = writeHarness();
    const out = await h.tool.execute({ entries: [] }, h.exec);
    check("5f. 空数组整句", out.ok === false && out.message === "entries must be a non-empty array", JSON.stringify(out.message));
    check("5f. 空数组时不写盘", h.current().length === 0, JSON.stringify(h.current()));
  }

  // 5g. **行为变更**：同一份计划里两条同角色，以前被接受，而第二条永远派发不到——
  // 派发是按角色名取第一条匹配（`findIndex`），第二条拿不到 id、status 永远 pending，不报错、不回声。
  // 现在在**写下来的那一刻**拒，并给出是第几条和第几条。
  {
    const dupe = "entries 0 and 1 both use persona \"worker\": a dispatch matches the first entry with that role, so entry 1 would never be dispatched and its status would stay pending. Give each entry a distinct role.";
    const h = writeHarness();
    const out = await h.tool.execute(
      { entries: [{ persona: ["worker", "a"], task: "first" }, { persona: ["worker", "b"], task: "second" }] },
      h.exec,
    );
    check("5g. 重复角色被拒（整句）", out.ok === false && out.message === dupe, JSON.stringify(out.message));
    check("5g. 被拒时账本一个字都没动", h.current().length === 0, JSON.stringify(h.current()));

    // 位置必须是**真实下标**，不是"第一次出现的位置"。
    const h2 = writeHarness();
    const out2 = await h2.tool.execute(
      {
        entries: [
          { persona: ["a", "d"], task: "1" },
          { persona: ["b", "d"], task: "2" },
          { persona: ["a", "d"], task: "3" },
        ],
      },
      h2.exec,
    );
    check(
      "5g. 位置印真实下标（0 与 2）",
      out2.message === dupe.replace('persona "worker"', 'persona "a"').replace("entries 0 and 1", "entries 0 and 2").replace("entry 1", "entry 2"),
      JSON.stringify(out2.message),
    );

    // 纯字符串保留角色与同名的数组形式也是同一个角色（派发按角色名匹配）：`"main"` 与 `["main","x"]`。
    const h3 = writeHarness();
    const out3 = await h3.tool.execute({ entries: [{ persona: "main", task: "1" }, { persona: ["main", "x"], task: "2" }] }, h3.exec);
    check("5g. \"main\" 与 [\"main\",\"x\"] 算同一个角色", out3.ok === false && /both use persona "main"/.test(out3.message), JSON.stringify(out3.message));

    // 角色各不相同：照旧写成功，账本条数对得上。
    const h4 = writeHarness();
    const out4 = await h4.tool.execute({ entries: [{ persona: ["a", "d"], task: "1" }, { persona: ["b", "d"], task: "2" }] }, h4.exec);
    check("5g. 角色各不相同照旧成功", out4.ok === true && out4.message === "arrangement written: 2 entries", JSON.stringify(out4.message));
    check("5g. 成功时两条都落盘", h4.current().length === 2, JSON.stringify(h4.current().length));
  }

  // 5h. 派发点不再静默替换黑名单：保留角色的固定工具面照旧生效，但条目上被丢掉的那份黑名单
  // 必须在回执里说出来。（写安排那道闸让这条形态在本版本不可达，所以这里**直接构造条目**钉住回执
  // 本身；见 tools.js 里 discardedNote 的说明。）
  {
    /** 条目由调用方直接给，好构造出写安排这道闸不允许落盘的形态。 */
    function dispatchHarness(entry, { children = [] } = {}) {
      const calls = { startContinuable: [], sendMessage: [] };
      const ctx = {
        logger: { debug: () => {}, warn: () => {}, info: () => {} },
        get: (name) => {
          if (name === "agents") return { get: () => undefined };
          if (name === "tools") return { schemas: () => [{ name: "read" }, { name: "edit" }, { name: "pwsh" }] };
          if (name === "subagents") {
            return {
              listChildren: async () => children,
              sendMessage: async (sender, targetId, content) => calls.sendMessage.push({ targetId, content }),
              startContinuable: async (spec) => {
                calls.startContinuable.push(spec);
                return { childId: spec.childId };
              },
            };
          }
          return undefined;
        },
      };
      const store = { getStage: () => "idle", loadEntries: async () => [entry], setEntries: () => {} };
      const exec = { agent: { id: "session-main", status: "running", session: { id: "session-main", header: { cwd: TEST_CWD } } }, signal: new AbortController().signal };
      return { ctx, store, exec, calls };
    }

    const keeper = {
      persona: ["memoryMaintainer", "x"],
      blacklist: ["edit", "read"],
      task: "keep the memories",
      id: "",
      status: "pending",
      summary: "",
    };
    const h = dispatchHarness(keeper);
    const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: "memoryMaintainer" }, h.exec);
    check("5h. 保留角色照旧派发", out.ok === true && h.calls.startContinuable.length === 1, JSON.stringify(out));
    // 回执骨架一字未动；被回显的三个值（角色名、跳过的清单、被丢掉的清单）现在都是有界文本，
    // 非字符串值因此带上了 JSON 引号——`"memoryMaintainer"`、`"edit, read"`。
    const keeperReceipt = /^dispatched "memoryMaintainer" as "[0-9a-f-]+" \(spawn\) \(blacklist skipped unknown tools: "[a-z_, ]+"\) \(blacklist discarded: this persona has a fixed tool face, so the entry's blacklist "edit, read" was ignored\)$/;
    check("5h. 回执整句（含被丢掉的黑名单）", keeperReceipt.test(out.message), out.message);
    check("5h. 回执其余部分不变", /^dispatched "memoryMaintainer" as "[0-9a-f-]+" \(spawn\)/.test(out.message), out.message);
    // 固定工具面本身照旧：`read` 是条目黑名单要挡的，但不是管家固定工具面要挡的（管家的清单里没有它），
    // 所以它**不许**出现在 toolFilter 里——出现了就说明条目黑名单其实生效了，那与"被丢掉"自相矛盾。
    const denied = h.calls.startContinuable[0]?.request?.toolFilter?.deny ?? [];
    check(
      "5h. 条目黑名单没有混进固定工具面（read 不在 deny 里，edit 来自固定清单）",
      Array.isArray(denied) && !denied.includes("read") && denied.includes("edit"),
      JSON.stringify(denied),
    );

    // 回执里没有这一句的情况：普通角色带黑名单时不许冒出来。
    const plain = dispatchHarness({ persona: ["worker", "d"], blacklist: ["edit"], task: "t", id: "", status: "pending", summary: "" });
    const plainOut = await kaSubWhaleTool({ ctx: plain.ctx, store: plain.store }).execute({ persona: "worker" }, plain.exec);
    check("5h. 普通角色不出现 discarded 字样", !/discarded/.test(plainOut.message), plainOut.message);

    // 复用那条分支也要说：复用发生在选工具面之前，回执同样是唯一出口。
    const reusableId = "77777777-8888-9999-0000-111111111114";
    const reused = dispatchHarness(keeper, { children: [{ kind: "child", mode: "continuable", label: "memoryMaintainer", id: reusableId }] });
    const reusedOut = await kaSubWhaleTool({ ctx: reused.ctx, store: reused.store }).execute({ persona: "memoryMaintainer" }, reused.exec);
    check(
      "5h. 复用分支同样报出被丢掉的黑名单",
      reusedOut.ok === true && /blacklist discarded: this persona has a fixed tool face/.test(reusedOut.message),
      reusedOut.message,
    );
  }

  // 5h'. **从盘上读回来的原始 JSON**：这一段是先前分析出错的地方——当时只用内存里构造的条目验过，
  // 于是得出"这条分支不可达"，而审查证明了它可达：早先版本的 `write_arrangement` 收下了
  // `["memoryMaintainer", …] + blacklist` 并写进盘，而加载器不校验（`readArrangement` 只有
  // `JSON.parse` + `Array.isArray`），派发点就会把那条原始条目照单接下。
  // 所以这里**手工写一个文件、走真的读盘入库**（`readArrangement` / `patchEntryAt`），不碰内存构造。
  {
    const SESSION = "session-on-disk";
    const raw = [
      {
        persona: ["memoryMaintainer", "old keeper"],
        blacklist: ["edit", "read"],
        task: "keep the memories",
        id: "",
        status: "pending",
        summary: "",
      },
    ];
    const file = arrangementFile(TEST_CWD, SESSION);
    mkdirSync(arrangementsDir(TEST_CWD), { recursive: true });
    writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
    check("5h'. 盘上确实躺着那个文件（原始 JSON，没过多校验）", JSON.parse(readFileSync(file, "utf8"))[0].blacklist[0] === "edit");

    // 加载器只做 JSON.parse + Array.isArray：这条条目带着黑名单原样回来了。
    const loaded = JSON.parse(readFileSync(file, "utf8"));
    check("5h'. 加载器不做形状校验（条目带黑名单原样入库）", Array.isArray(loaded) && loaded[0].persona[0] === "memoryMaintainer" && loaded[0].blacklist.length === 2, JSON.stringify(loaded));

    const calls = { startContinuable: [] };
    const ctx = {
      logger: { debug: () => {}, warn: () => {}, info: () => {} },
      get: (name) => {
        if (name === "agents") return { get: () => undefined };
        if (name === "tools") return { schemas: () => [{ name: "read" }, { name: "edit" }] };
        if (name === "subagents") {
          return {
            listChildren: async () => [],
            sendMessage: async () => {},
            startContinuable: async (spec) => {
              calls.startContinuable.push(spec);
              return { childId: spec.childId };
            },
          };
        }
        return undefined;
      },
    };
    // store 走**真的读盘/回填**那两条：loadEntries = readArrangement，patchEntryAt 也是真的。
    const store = {
      getStage: () => "idle",
      loadEntries: (sessionId) => readArrangement(TEST_CWD, sessionId),
      setEntries: () => {},
      patchEntryAt: (sessionId, index, patch) => patchEntryAt(TEST_CWD, sessionId, index, patch),
    };
    const exec = { agent: { id: SESSION, status: "running", session: { id: SESSION, header: { cwd: TEST_CWD } } }, signal: new AbortController().signal };
    const out = await kaSubWhaleTool({ ctx, store }).execute({ persona: "memoryMaintainer" }, exec);
    check("5h'. 盘上那条被照单派发（没被任何一道闸拦住）", out.ok === true && calls.startContinuable.length === 1, JSON.stringify(out));
    check(
      "5h'. 回执报出被丢掉的黑名单：这一条是从盘上读来的，不是内存构造的",
      /\(blacklist discarded: this persona has a fixed tool face, so the entry's blacklist "edit, read" was ignored\)/.test(out.message),
      out.message,
    );
    // 顺带把"写到盘上去了"这件事钉住：文件确实被回填了 status。
    check("5h'. 回填真的落到盘上（status 变 running）", JSON.parse(readFileSync(file, "utf8"))[0].status === "running", readFileSync(file, "utf8"));
  }

  // 5i. fork 值渲染：被拒的值必须**原样印出来**（字符串带引号、非字符串带类型），模型才认得出自己写了什么。
  // 旧代码在这里只印过 `undefined`（`:110` 的 `JSON.stringify(raw)` 对 undefined 返回 undefined 本身）。
  {
    const render = (raw) => (forkValueOf(raw).error ?? "").split("got ")[1]?.split(" — this field")[0];
    check('5i. 渲染 true → "true (boolean)"', render(true) === "true (boolean)", JSON.stringify(render(true)));
    check('5i. 渲染 false → "false (boolean)"', render(false) === "false (boolean)", JSON.stringify(render(false)));
    check('5i. 渲染 0 → "0 (number)"', render(0) === "0 (number)", JSON.stringify(render(0)));
    check('5i. 渲染 [] → "[] (object)"', render([]) === "[] (object)", JSON.stringify(render([])));
    check('5i. 渲染 {} → "{} (object)"', render({}) === "{} (object)", JSON.stringify(render({})));
    check('5i. 渲染 "yes" → "\\"yes\\""（字符串带引号、不带类型）', render("yes") === '"yes"', JSON.stringify(render("yes")));
    check('5i. 渲染 "TRUE" 原样保留大小写', render("TRUE") === '"TRUE"', JSON.stringify(render("TRUE")));
    check('5i. 渲染 "session main" 原样（含空格）', render("session main") === '"session main"', JSON.stringify(render("session main")));
    // 合法值不渲染成错值：`undefined` / `null` / 空串 / "none" 都归"不 fork"，一个都不许出现在报错里。
    for (const okValue of [undefined, null, "", "   ", "none"]) {
      check(`5i. fork=${JSON.stringify(okValue)} 不走报错分支`, forkValueOf(okValue).error === undefined, JSON.stringify(forkValueOf(okValue)));
    }
  }

  // 5j. 这两条是**纯函数一层**的钉子，防的是"文案改回去而套件不红"这件事再次发生。
  {
    check(
      "5j. 旧 E5 文案（引 persona 当主语）已不存在",
      normalizeEntry({ persona: ["worker", "d"] }).error !== 'entry ["worker","d"] needs a task',
    );
    check("5j. duplicatePersonaProblem 无重复时返回 null", duplicatePersonaProblem([{ persona: ["a", "d"] }, { persona: ["b", "d"] }]) === null);
    check("5j. duplicatePersonaProblem 空计划返回 null", duplicatePersonaProblem([]) === null);
  }
  // 5k. **长值不许整段进上下文**：这四条是审查实测出来的缺陷——把几千到几万字的正文写进 persona
  // 或 fork，报错就把整段原样印一遍。修法是同一个：能印角色名就印角色名，必须印原始值时截断到
  // ERROR_ECHO_MAX_CHARS 并写明省了多少字符。每条都断言**实际长度**，不只看"变小了"。
  {
    const LONG = "X".repeat(5400);
    const HUGE = "Y".repeat(50000);

    // 上界取 500：骨架最大的那条（E7，212 字）加上被截断的值（222 字）实测 434 字，
    // 所以 500 是"确实有界"的断言，不是把常数抄一遍。原先写 400 是我估错了骨架长度。
    const worst = (text) => `报错实际长度 ${text.length}`;

    // E6：这道闸是本次改动**新增**了数组形式这条可达路径的，所以这个泄漏是本次引入的。
    const e6 = normalizeEntry({ persona: ["memoryMaintainer", LONG], blacklist: ["edit"], task: T }).error ?? "";
    check("5k. E6 长描述：整句只有角色名（不含描述）", e6.includes('persona "memoryMaintainer" has a fixed tool face'), e6.slice(0, 120));
    check(`5k. E6 长描述：${worst(e6)} ≤ 500`, e6.length <= 500, `len=${e6.length}`);
    check("5k. E6 长描述：描述正文一个字都不在报错里", !e6.includes(LONG), `len=${e6.length}`);

    // E7：回显值有界，并写明省了多少字符。
    const e7 = normalizeEntry({ persona: ["worker", "d"], task: T, fork: HUGE }).error ?? "";
    check(`5k. E7 超长 fork：${worst(e7)} ≤ 500`, e7.length <= 500, `len=${e7.length}`);
    check("5k. E7 超长 fork：写明省了多少字符", e7.includes(`(+${HUGE.length + 2 - (ERROR_ECHO_MAX_CHARS - 1)} more chars)`), e7.slice(-90));
    check("5k. E7 超长 fork：原值一个字都不在报错里", !e7.includes(HUGE), `len=${e7.length}`);

    // E2：纯字符串 persona 是另一个原样回显点（这个在门槛**之前**就存在，一样有界化）。
    const e2 = normalizeEntry({ persona: HUGE, task: T }).error ?? "";
    check(`5k. E2 超长 persona：${worst(e2)} ≤ 500`, e2.length <= 500, `len=${e2.length}`);
    check("5k. E2 超长 persona：原值一个字都不在报错里", !e2.includes(HUGE), `len=${e2.length}`);

    // E5 的另一条路：`task` 不是字符串且本身超长。
    const e5 = normalizeEntry({ persona: ["worker", "d"], task: { blob: HUGE } }).error ?? "";
    check(`5k. E5 超长非字符串 task：${worst(e5)} ≤ 500`, e5.length <= 500, `len=${e5.length}`);
    check("5k. E5 超长非字符串 task：原值一个字都不在报错里", !e5.includes(HUGE), `len=${e5.length}`);
  }

  // 5l. `boundedShown` 本身的边界：短值一字不改，长值截断到上界 + 写明省了多少，代理对不被切一半。
  {
    check("5l. 短字符串原样（带引号）", boundedShown("worker") === '"worker"', boundedShown("worker"));
    check("5l. 短值长度就是原样", boundedShown("x".repeat(ERROR_ECHO_MAX_CHARS - 2)).length === ERROR_ECHO_MAX_CHARS, String(boundedShown("x".repeat(ERROR_ECHO_MAX_CHARS - 2)).length));
    const long = boundedShown("x".repeat(1000));
    check("5l. 长值：截断处写明省了多少", /… \(\+\d+ more chars\)$/.test(long), long.slice(-40));
    check("5l. 长值：上界 + 后缀 = 有界", long.length <= ERROR_ECHO_MAX_CHARS + 32, String(long.length));
    // 切点正好落在代理对的高位代理上：往前多让一个字符，不许产出孤立代理（U+FFFD）。
    const pair = `${"a".repeat(ERROR_ECHO_MAX_CHARS - 3)}😀${"b".repeat(50)}`;
    const cut = boundedShown(pair);
    check("5l. 代理对不被切一半（没有 U+FFFD）", !cut.includes("\uFFFD"), JSON.stringify(cut.slice(-40)));
    check("5l. 非字符串值也能回显（对象/数字/布尔）", boundedShown(42) === "42" && boundedShown(true) === "true" && boundedShown([]) === "[]", `${boundedShown(42)}/${boundedShown(true)}/${boundedShown([])}`);
  }

  // 5m. **测试自己不碰活 home**：这一份套件跑完，主 home 的 arrangements 目录里不许多出任何文件。
  // （本文件开头把 DSH_HOME 指向了临时目录；这几条防的是有人把它改回去。）
  {
    check("5m. DSH_HOME 指向临时目录", process.env.DSH_HOME === TEST_HOME && TEST_HOME !== "", String(process.env.DSH_HOME));
    check("5m. 替身会话的 cwd 在临时目录里", TEST_CWD.startsWith(TEST_HOME), TEST_CWD);
    // 形状为什么不断言成 `<home>\.dsh\…`：cwd 为空时 arrangementsDir **直接用 DSH_HOME 本身**
    // （只有给了 cwd 才在它下面加 `.dsh`，见 arrangementsDir 的三元那一行）。所以这里断言的是
    // "落在临时 home 底下"，而不是某一个具体形状。
    check("5m. arrangementsDir(\"\") 落在临时 home 底下", arrangementsDir("").startsWith(TEST_HOME), arrangementsDir(""));
    check("5m. arrangementsDir(cwd) 也落在临时 home 底下", arrangementsDir(TEST_CWD).startsWith(TEST_HOME), arrangementsDir(TEST_CWD));
    // 真正要防的那件事：cwd 为空时写盘，文件必须落在临时 home 里，而不是活 home 的 storages 下。
    const exec = { agent: { id: "session-hermetic", status: "running", session: { id: "session-hermetic", header: { cwd: "" } } } };
    const store = { getStage: () => "arrange_agent", loadEntries: async () => [], setEntries: () => {} };
    await writeArrangementTool({ store }).execute({ entries: [{ persona: ["a", "d"], task: "t" }] }, exec);
    const landed = arrangementFile("", "session-hermetic");
    check("5m. cwd 为空时写盘落在临时 home 里", landed.startsWith(TEST_HOME) && existsSync(landed), landed);
  }
  // 5n. **每一个回显点各一条 50,000 字**：这条是补课。5k 当初只钉了"已经修好的那几种形状"，
  // 于是同一行上没被钉住的形状（E7 的超长 persona 数组、重复角色消息里的超长角色名）带着缺陷
  // 一路绿过去了；而 tools.js 里那些回显点更是一条都没测过——审查在那里量到过 100,401 字。
  // 每个点都断言两件事：**有上界**、**原值一个字都不在消息里**。
  {
    const HUGE = "Y".repeat(50000);
    // 上界怎么来的：单一回显最多 222 字（骨架最长的一条 E7 骨架 212 字，实测单条上限 434 字）。
    // 但**有界是逐处的，不是逐条的**——一条派发回执会把最多四个回显拼在一起（角色名、跳过的
    // 清单、被丢掉的清单、fork 目标），所以这里的 1000 是"一条消息"的上界，5p 单独把那个
    // 合成上界钉住（实测 ~900）。宁可先把话说全：677 不是本行的最坏值，它只是"并发上限那条
    // 回执"一个点的值。
    const BOUND = 1000;
    let site = 0;
    const assertBounded = (label, text, cap = BOUND) => {
      site += 1;
      check(`5n.${site} ${label}：长度 ${text.length} ≤ ${cap}`, text.length <= cap, `len=${text.length}`);
      check(`5n.${site} ${label}：原值一个字都不在消息里`, !text.includes(HUGE), `len=${text.length}`);
    };

    // ── 纯函数层 ──────────────────────────────────────────────────────────────
    assertBounded("E7 前缀（超长 persona 数组）", normalizeEntry({ persona: ["r", HUGE], task: T, fork: true }).error ?? "");
    assertBounded("重复角色（超长角色名）", duplicatePersonaProblem([{ persona: [HUGE, "a"] }, { persona: [HUGE, "b"] }]) ?? "");
    assertBounded("E7 回显值（超长 fork）", normalizeEntry({ persona: ["r", "d"], task: T, fork: HUGE }).error ?? "");
    assertBounded("E2（超长 persona）", normalizeEntry({ persona: HUGE, task: T }).error ?? "");
    assertBounded("E6（超长行为描述）", normalizeEntry({ persona: ["memoryMaintainer", HUGE], blacklist: ["edit"], task: T }).error ?? "");
    assertBounded("E5（超长非字符串 task）", normalizeEntry({ persona: ["r", "d"], task: { blob: HUGE } }).error ?? "");

    // ── tools.js：每个回显点各一条 ────────────────────────────────────────────
    const DISPATCHER = "session-main";
    /** 一个够用的 ctx + store + subagents 替身；entries / children / agents 由调用方给。 */
    function toolHarness({ entries, children = [], agents = {}, knownTools = ["read", "edit"] } = {}) {
      const calls = { startContinuable: [], sendMessage: [], written: [] };
      const agentTable = new Map(Object.entries(agents));
      const ctx = {
        logger: { debug: () => {}, warn: () => {}, info: () => {} },
        get: (name) => {
          if (name === "agents") return { get: (id) => agentTable.get(id) };
          if (name === "tools") return { schemas: () => knownTools.map((toolName) => ({ name: toolName })) };
          if (name === "subagents") {
            return {
              listChildren: async () => children,
              sendMessage: async (sender, targetId, content) => calls.sendMessage.push({ targetId, content }),
              startContinuable: async (spec) => {
                calls.startContinuable.push(spec);
                return { childId: spec.childId };
              },
            };
          }
          return undefined;
        },
      };
      const store = {
        getStage: () => "idle",
        loadEntries: async () => entries,
        setEntries: () => {},
        patchEntryAt: async () => entries,
      };
      const exec = { agent: { id: DISPATCHER, status: "running", session: { id: DISPATCHER, header: { cwd: TEST_CWD } } }, signal: new AbortController().signal };
      return { ctx, store, exec, calls };
    }
    const mkEntry = (persona, extra = {}) => ({ persona, blacklist: [], task: "t", id: "", status: "pending", summary: "" , ...extra });

    // get_arrangement：找不到条目时回显 wanted。
    {
      const h = toolHarness({ entries: [] });
      const out = await getArrangementTool({ store: h.store }).execute({ persona: HUGE }, h.exec);
      assertBounded("get_arrangement 的 wanted", out.message);
    }

    // ka_sub_whale：找不到条目时同样回显 wanted。
    {
      const h = toolHarness({ entries: [mkEntry(["other", "d"])] });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: HUGE }, h.exec);
      assertBounded("ka_sub_whale 的 wanted", out.message);
    }

    // 派发新子代理：回执里的角色名（label）与"跳过的工具名"清单。
    {
      const h = toolHarness({ entries: [mkEntry([HUGE, "d"], { blacklist: [HUGE, "read"] })] });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: HUGE }, h.exec);
      assertBounded("回执里的角色名（label）", out.message);
      assertBounded("回执里的 skippedNote（黑名单清单）", out.message);
    }

    // 被复用时：回执两处都回显。
    {
      const reusable = "77777777-8888-9999-0000-111111111125";
      const h = toolHarness({
        entries: [mkEntry([HUGE, "d"], { blacklist: [HUGE] })],
        children: [{ kind: "child", mode: "continuable", label: HUGE, id: reusable }],
      });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: HUGE }, h.exec);
      assertBounded("复用回执里的角色名", out.message);
      assertBounded("复用回执里的 discardedNote", out.message);
    }

    // fork 目标失效：回显一个不是活会话的目标。
    {
      const h = toolHarness({ entries: [mkEntry(["r", "d"], { fork: HUGE })] });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: "r" }, h.exec);
      assertBounded("回执里的 fork 目标（fallback）", out.message);
    }

    // 复用分支里"fork 目标没被应用"那句。
    {
      const reusable = "77777777-8888-9999-0000-111111111126";
      const h = toolHarness({
        entries: [mkEntry(["r", "d"], { fork: HUGE })],
        children: [{ kind: "child", mode: "continuable", label: "r", id: reusable }],
      });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: "r" }, h.exec);
      assertBounded("复用回执里的 fork 目标（NOT applied）", out.message);
    }

    // 需要平台枚举时回显 busyId（注册表里状态是 running 的那个孩子）。
    {
      const busy = "77777777-8888-9999-0000-111111111127";
      const h = toolHarness({
        entries: [mkEntry([HUGE, "d"])],
        children: [{ kind: "child", mode: "continuable", label: HUGE, id: busy }],
        agents: { [busy]: { id: busy, status: "running" } },
      });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: HUGE }, h.exec);
      check("5n.busy 走的是「还在忙」那条路", out.ok === false && /is still working/.test(out.message), out.message.slice(0, 80));
      assertBounded("回执里的 busyId", out.message);
    }

    // 并发上限那条路：回显角色名。
    {
      const children = [];
      const agents = {};
      for (let i = 0; i < 5; i += 1) {
        const id = `88888888-0000-0000-0000-00000000000${i}`;
        children.push({ kind: "child", mode: "continuable", label: `other-${i}`, id });
        agents[id] = { id, status: "running" };
      }
      const h = toolHarness({ entries: [mkEntry([HUGE, "d"])], children, agents });
      const out = await kaSubWhaleTool({ ctx: h.ctx, store: h.store }).execute({ persona: HUGE }, h.exec);
      check("5n.cap 走的是并发上限那条路", out.ok === false && /already running/.test(out.message), out.message.slice(0, 60));
      assertBounded("上限回执里的角色名", out.message);
    }

    // whale_report：未知阶段。**平台比这个函数先动手**：`stage` 声明的 enum 让参数校验直接
    // `ToolArgsError`，`execute` 根本进不去——所以这条分支今天够不着（工具描述里那句话是对的）。
    // 这里断言的是这件事实本身，再把"那条分支一旦跑起来不会印几万字"钉在一句直接调用上。
    {
      const store = { getStage: () => "idle", setStage: () => {}, loadEntries: async () => [], setEntries: () => {} };
      const reportExec = { agent: { id: DISPATCHER, status: "running", session: { id: DISPATCHER, header: { cwd: TEST_CWD } } } };
      let blockedByPlatform = false;
      try {
        await whaleReportTool({ store }).execute({ stage: HUGE }, reportExec);
      } catch (error) {
        blockedByPlatform = /stage.*must be one of|ToolArgsError|invalid arguments/.test(String(error));
      }
      check("5n.stage 平台按 enum 挡在 execute 之前（这就是那条分支够不着的原因）", blockedByPlatform);
      // 那句回显本身有界：骨架 + 被截断的值，不是一个 5 万字的 target。
      const bounded = `unknown stage ${boundedShown(HUGE)}; known stages: idle, arrange_agent, self-check`;
      assertBounded("unknown stage 的 target（直接调有界回显）", bounded);
    }

    // 空串不该被有界化搅成 `"" … (+N more chars)`：短值与空值原样通过。
    check("5n. 空串原样（不写成 +more chars）", boundedShown("") === '""', boundedShown(""));
  }

  // 5o. `boundedShown` 对 JSON.stringify 会抛的两种值不许抛：BigInt 与循环引用。
  // 它们**到不了**这里（工具入参是 JSON 解析出来的，构造不出这两者），但函数是导出的、会被复用，
  // 一个"回显函数在回显时抛异常"的失败模式会把整条报错路径变成一个未捕获异常。
  {
    const bigint = boundedShown(10n ** 30n);
    check("5o. BigInt 不抛，退回 String()", typeof bigint === "string" && bigint.startsWith("1"), bigint);
    const circular = {};
    circular.self = circular;
    const shown = boundedShown(circular);
    check("5o. 循环引用不抛，退回 String()", shown === "[object Object]", JSON.stringify(shown));
    const arr = [];
    arr.push(arr);
    check("5o. 自引用数组不抛", typeof boundedShown(arr) === "string", JSON.stringify(boundedShown(arr)).slice(0, 40));
  }
  // 5p. **有界是逐处的，不是逐条的**：一条派发回执最多同时拼进四个有界回显（角色名、跳过的
  // 清单、被丢掉的清单、fork 目标）。5n 每条只断言"这一个回显有界"，所以它证明不了整条消息的
  // 上界——这里把合成的那条钉住，并给出实测数字。审查量到过 991 字，本条断言 ≤ 1500。
  {
    const HUGE = "Y".repeat(50000);
    // 200 个平台已知的工具 + 200 个不在清单里的黑名单项：逼出最长的 skippedNote 与 discardedNote。
    const known = Array.from({ length: 200 }, (_, i) => `tool_${i}`);
    const entry = {
      persona: [HUGE, "d"],
      blacklist: known.map((name) => `x${name}`),
      task: "t",
      fork: HUGE,
      id: "",
      status: "pending",
      summary: "",
    };
    const calls = { startContinuable: [] };
    const ctx = {
      logger: { debug: () => {}, warn: () => {}, info: () => {} },
      get: (name) => {
        if (name === "agents") return { get: () => undefined };
        if (name === "tools") return { schemas: () => known.map((n) => ({ name: n })) };
        if (name === "subagents") {
          return {
            listChildren: async () => [],
            sendMessage: async () => {},
            startContinuable: async (spec) => {
              calls.startContinuable.push(spec);
              return { childId: spec.childId };
            },
          };
        }
        return undefined;
      },
    };
    const store = { getStage: () => "idle", loadEntries: async () => [entry], setEntries: () => {}, patchEntryAt: async () => [entry] };
    const exec = { agent: { id: "session-main", status: "running", session: { id: "session-main", header: { cwd: TEST_CWD } } }, signal: new AbortController().signal };
    const out = await kaSubWhaleTool({ ctx, store }).execute({ persona: HUGE }, exec);
    check("5p. 合成回执里确实有被截断的回显", /… \(\+\d+ more chars\)/.test(out.message), out.message.slice(0, 120));
    check(`5p. 合成回执长度 ${out.message.length} ≤ 1500（逐处有界，逐条只能给一个上界）`, out.message.length <= 1500, `len=${out.message.length}`);
    check("5p. 合成回执里没有原值", !out.message.includes(HUGE), `len=${out.message.length}`);
    // 单个回显的实际上界：cap + "… (+N more chars)" 后缀。
    check(`5p. 单次回显 ≤ ${ERROR_ECHO_MAX_CHARS + 22} 字`, boundedShown(HUGE).length <= ERROR_ECHO_MAX_CHARS + 22, String(boundedShown(HUGE).length));
  }

  // 5q. **同预设行里另两处未做有界化的回显**——不在本次改动范围内（没有批准修），所以这里
  // 只把"它们确实还在、有多长"钉成事实，好让下一个读注释的人**去查**而不是去信。
  //   * kaz-context-policy/lib/search.js:81        —— unknown companion "${wanted}"
  //   * ka-whale-memory/lib/tools.js:234           —— no memory named "${String(args.name ?? "")}"
  // 断言分两层：**源码里那两行确实还在**（直接读文件，钉住行号附近的原文），以及用 5 万字入参
  // 复刻模板串量出长度。真调用它们需要活体注册表／记忆存储，而这里要证明的只是"缺口存在"。
  {
    const HUGE = "Y".repeat(50000);
    const rowRoot = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
    const readRow = (relative) => readFileSync(join(rowRoot, relative), "utf8");

    const searchSrc = readRow("functions/kaz-context-policy/lib/search.js");
    check("5q. search.js 里 `unknown companion` 回显仍在（未修）", searchSrc.includes('unknown companion "${wanted}"'), "source line moved - re-measure before citing it");
    const memorySrc = readRow("functions/ka-whale-memory/lib/tools.js");
    check(
      "5q. memory tools.js 里 `no memory named` 回显仍在（未修）",
      memorySrc.includes('no memory named "${String(args.name ?? "")}"'),
      "source line moved - re-measure before citing it",
    );

    // 名字参数没有 maxLength：五个工具各一处、都是 `{type:"string", required:true}` 开头，
    // 而且整个文件里 `maxLength` 出现 0 次。
    const nameDecls = memorySrc.match(/name: \{ type: "string", required: true/g) ?? [];
    check(`5q. memory 的 name 参数声明共 ${nameDecls.length} 处（memory_search/detail/list/save/update/forget）`, nameDecls.length === 5, JSON.stringify(nameDecls.length));
    check("5q. memory 的 name 参数没有一处带 maxLength", !/name: \{[^}]*maxLength/u.test(memorySrc), "a maxLength appeared - re-measure the gap");

    const companion = `unknown companion "${HUGE}"; known companions: main`;
    const memory = `failure: no memory named "${HUGE}"`;
    check(`5q. context_search 的 companion 回显 5 万字下是 ${companion.length} 字（已知缺口，未修）`, companion.length > 50000, String(companion.length));
    check(`5q. memory_detail 的 name 回显 5 万字下是 ${memory.length} 字（已知缺口，未修）`, memory.length > 50000, String(memory.length));
  }
  // 5r. 扫描的年龄判据：**取目录及其内容里最新的 mtime**，不是目录自己的。
  // 这条测的就是先前写错的那个理由：目录 mtime 只反映"最后一次往里面加东西"，所以一个"先把文件
  // 建好、之后只往里写"的运行，目录 mtime 会停在建目录那一刻。只看目录 mtime，它**越跑越显老**，
  // 一个还在跑的运行就可能被当成垃圾收走。这里用同一个函数（不是复刻逻辑）把这三种形态钉住：
  //   a) 目录 mtime 很旧、但内容刚写过 → 必须**留着**；
  //   b) 目录 mtime 很旧、内容也旧       → 必须**收掉**（这是被中断的那一类）；
  //   c) 名字命中前缀但不是目录           → 必须**跳过**并计数，不许当成目录删。
  {
    const OLD = new Date(Date.now() - 30 * 60 * 1000);
    const mk = (name) => {
      const path = join(tmpdir(), `${SWEEP_PREFIX}${name}`);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const ageDirOnly = (path) => {
      const mark = Math.floor(OLD.getTime() / 1000);
      utimesSync(path, mark, mark);
    };

    // a) 活的：建好文件、把目录 mtime 做旧，然后只**改写**那个已存在的文件（目录 mtime 不会动）。
    const live = mk("LIVE-PROBE");
    const liveFile = join(live, "inside.txt");
    writeFileSync(liveFile, "first");
    ageDirOnly(live);
    writeFileSync(liveFile, "rewritten while the run is still working");
    check("5r. 前置条件：目录 mtime 确实是旧的（改写不刷新它）", Date.now() - statSync(live).mtimeMs > 20 * 60 * 1000, String(Math.round((Date.now() - statSync(live).mtimeMs) / 1000)) + "s");

    // b) 死的：目录旧、内容也旧。
    const dead = mk("DEAD-PROBE");
    writeFileSync(join(dead, "inside.txt"), "left by an interrupted run");
    const mark = Math.floor(OLD.getTime() / 1000);
    utimesSync(join(dead, "inside.txt"), mark, mark);
    ageDirOnly(dead);

    // c) 同名但不是目录。
    const fileNotDir = join(tmpdir(), `${SWEEP_PREFIX}FILE-NOT-DIR`);
    writeFileSync(fileNotDir, "not a directory");

    const result = sweepOrphanedTempHomes();
    check("5r. 内容刚写过的目录留在原地（还在跑的那一类）", existsSync(live), live);
    check("5r. 目录与内容都旧的目录被收掉（被中断的那一类）", !existsSync(dead), dead);
    check("5r. 同名但不是目录的条目被跳过、没被删", existsSync(fileNotDir), fileNotDir);
    check(`5r. 扫描自报了跳过数（skipped=${result.skipped}）`, result.skipped >= 1, JSON.stringify(result));

    rmSync(live, { recursive: true, force: true });
    rmSync(fileNotDir, { force: true });
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
for (const line of results) console.log(line);
// 跑到这里就已经结束了：显式清一次（幂等），让"成功了"这件事**看得见**。
// 这一行走 **stdout**，是本文件 stdout 正文的最后一行；只有清理**失败**才走 stderr
// （见 removeTempHome）。这一句不参与判决：它失败也照样是上面的 FAIL 行与退出码说了算。
removeTempHome();
console.log(`${tempHomeRemoved ? "temp home removed" : "temp home NOT removed"}: ${TEST_HOME}`);
console.log(`orphaned temp homes swept at startup: ${sweptBefore.removed} (skipped, name matched but not a directory: ${sweptBefore.skipped})`);
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
