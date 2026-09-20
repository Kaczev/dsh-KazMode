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

import { forkValueOf, normalizeEntry, FORK_FROM_MAIN } from "./functions/ka-whale-workflow/lib/arrangement.js";
import { KAZ_FORK_PROVIDER, completedTurnPrefix, createKazForkProvider, noteForkSource, resolveForkTarget } from "./functions/ka-whale-workflow/lib/fork-provider.js";
import { writeArrangementTool, kaSubWhaleTool } from "./functions/ka-whale-workflow/lib/tools.js";

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
      agent: { id: DISPATCHER_ID, status: "running", session: { id: DISPATCHER_ID, header: { cwd: "" } } },
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

// ── 汇总 ─────────────────────────────────────────────────────────────────────
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
