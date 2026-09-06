// kaz-context-policy M3.2b 探针：插件工具 context_search / context_read
// ===========================================================================
// 离线验证：stub ctx.tools.register + fake exec.agent.session.events
// （events 含 append 原文、replacement checkpoint、compaction 日志）。
// 运行：node KazPlugins/kaz-context-policy/probe-context-tools.mjs
// ===========================================================================

import plugin from "./lib/index.js";

let passed = 0;
let failures = 0;

const check = (label, ok, detail = "") => {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed += 1;
  else failures += 1;
};

const failWith = (result, code) =>
  result &&
  result.ok === false &&
  result.code === code &&
  typeof result.reason === "string";

// ---------- fake 注册面 ----------
const registered = [];
let disposedCount = 0;
let cleanup = null;
const ctx = {
  logger: {
    warn() {},
    info() {},
    debug() {},
  },
  tools: {
    register(def) {
      registered.push(def);
      let called = false;
      return () => {
        if (called) return;
        called = true;
        disposedCount += 1;
      };
    },
  },
  effect(registerCleanup) {
    cleanup = registerCleanup();
  },
};

// ---------- fake session events（含 replacement / compaction） ----------
const ev = (seq, type, data, surfaceOp = "append", time) => {
  const event = { seq, type, data };
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
  if (time !== undefined) event.time = time;
  return event;
};

const textContent = (text) => [{ type: "text", text }];
const assistantMessage = (text) => ({
  role: "assistant",
  content: textContent(text),
});
const toolResultMessage = (text) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      content: textContent(text),
    },
  ],
});

const events = [
  ev(10, "user/message", "Original task: vault code is AlphaBeta", "append", "t-10"),
  ev(
    20,
    "assistant/message",
    { message: assistantMessage("I will inspect the needle in step one.") },
    "append",
    200,
  ),
  ev(
    30,
    "tool/result",
    { message: toolResultMessage("tool result contains needleX plus boring data") },
    "append",
  ),
  ev(40, "user/message", "Later question about needley detail", "append"),
  ev(
    50,
    "user/message",
    "ZZCHECKPOINTZZ AlphaBeta collapsed away",
    { op: "replace", start: 10, end: 20 },
  ),
  ev(
    60,
    "tool/result",
    { message: toolResultMessage("ZZREWRITTENZZ tool surface") },
    { op: "replace", start: 30, end: 30 },
  ),
  ev(70, "compaction/summary", { shadowedSeqs: [10, 20, 30] }),
  ev(80, "user/message", "Fresh tail after checkpoint", "append", "t-80"),
  ev(90, "turn/start", { turn: 1 }),
];

const session = {
  events: events.slice(),
  header: { cwd: "C:\\fake\\project" },
};

function execFor(agentLike) {
  return {
    agent: agentLike,
    callId: "call-test",
    signal: new AbortController().signal,
  };
}

const exec = execFor({ session });
const eventsSnapshot = JSON.stringify(events);
const sessionSnapshot = JSON.stringify(session);

// ---------- 插件注册 ----------
plugin.apply(ctx);

const byName = Object.fromEntries(registered.map((def) => [def.name, def]));
check(
  "注册 context_search/context_read 两个工具",
  registered.length === 2 &&
    Object.prototype.hasOwnProperty.call(byName, "context_search") &&
    Object.prototype.hasOwnProperty.call(byName, "context_read"),
  registered.map((d) => d.name).join(","),
);
check(
  "两个工具都带 JSON 文本 output.render",
  typeof byName.context_search.output.render === "function" &&
    typeof byName.context_read.output.render === "function",
);

const searchDef = byName.context_search;
const readDef = byName.context_read;
check(
  "context_search schema：query required，limit/cursor optional",
  searchDef.parameters.type === "object" &&
    searchDef.parameters.properties.query?.type === "string" &&
    JSON.stringify(searchDef.parameters.required) === JSON.stringify(["query"]) &&
    searchDef.parameters.properties.limit?.type === "integer" &&
    searchDef.parameters.properties.cursor?.type === "string" &&
    !searchDef.parameters.required.includes("limit") &&
    !searchDef.parameters.required.includes("cursor"),
);
check(
  "context_read schema：seqs number|number[] required",
  readDef.parameters.type === "object" &&
    JSON.stringify(readDef.parameters.required) === JSON.stringify(["seqs"]) &&
    readDef.parameters.properties.seqs?.oneOf !== undefined,
  JSON.stringify(readDef.parameters.properties.seqs),
);

// ---------- context_search 命中 ----------
const searchNeedle = await searchDef.execute({ query: "needle" }, exec);
check(
  "context_search needle 命中 append 原文 40/30/20（降序）",
  searchNeedle.ok === true &&
    searchNeedle.total === 3 &&
    JSON.stringify(searchNeedle.page.map((x) => x.seq)) === "[40,30,20]",
  JSON.stringify(searchNeedle.page?.map((x) => [x.seq, x.kind, x.time])),
);
check(
  "context_search 命中项带 kind/time/snippet 且不截断字段",
  searchNeedle.page[0].kind === "user" &&
    searchNeedle.page[0].time === undefined &&
    searchNeedle.page[0].snippet.includes("needley") &&
    searchNeedle.page[1].kind === "tool" &&
    searchNeedle.page[1].snippet.includes("needleX") &&
    searchNeedle.page[2].kind === "assistant" &&
    searchNeedle.page[2].time === 200,
);

const searchAlpha = await searchDef.execute({ query: "AlphaBeta" }, exec);
check(
  "context_search AlphaBeta 命中旧 append 原文 seq10（replacement 副本不进入）",
  searchAlpha.ok === true &&
    searchAlpha.total === 1 &&
    searchAlpha.page[0].seq === 10 &&
    searchAlpha.page[0].time === "t-10",
  JSON.stringify(searchAlpha),
);
check(
  "replacement checkpoint 文本 ZZCHECKPOINTZZ 不命中",
  (await searchDef.execute({ query: "ZZCHECKPOINTZZ" }, exec)).ok === true &&
    (await searchDef.execute({ query: "ZZCHECKPOINTZZ" }, exec)).total === 0,
);
check(
  "replacement 工具面文本 ZZREWRITTENZZ 不命中",
  (await searchDef.execute({ query: "ZZREWRITTENZZ" }, exec)).ok === true &&
    (await searchDef.execute({ query: "ZZREWRITTENZZ" }, exec)).total === 0,
);

const page1 = await searchDef.execute({ query: "needle", limit: 1 }, exec);
const page2 = await searchDef.execute(
  { query: "needle", limit: 1, cursor: page1.nextCursor },
  exec,
);
check(
  "context_search limit+cursor 分页：第 1 页 40 hasMore，第 2 页 30",
  page1.ok === true &&
    page1.total === 3 &&
    page1.page.length === 1 &&
    page1.page[0].seq === 40 &&
    page1.hasMore === true &&
    typeof page1.nextCursor === "string" &&
    page2.ok === true &&
    page2.total === 3 &&
    page2.page.length === 1 &&
    page2.page[0].seq === 30 &&
    page2.hasMore === true,
  JSON.stringify({ p1: page1, p2: page2 }),
);

const emptyQuery = await searchDef.execute({ query: "   " }, exec);
check(
  "context_search 空 query → 结构化 empty-query",
  failWith(emptyQuery, "empty-query"),
  JSON.stringify(emptyQuery),
);

// ---------- context_read 读取 / 错误 ----------
const readTwo = await readDef.execute({ seqs: [10, 40] }, exec);
check(
  "context_read [10,40] 返回逐字原文与顺序",
  readTwo.ok === true &&
    readTwo.items.length === 2 &&
    JSON.stringify(readTwo.items.map((x) => x.seq)) === "[10,40]" &&
    readTwo.items[0].text === "Original task: vault code is AlphaBeta" &&
    readTwo.items[1].text === "Later question about needley detail" &&
    readTwo.items[0].kind === "user" &&
    readTwo.items[0].time === "t-10" &&
    readTwo.omitted === 0,
  JSON.stringify(readTwo),
);

const readSingle = await readDef.execute({ seqs: 20 }, exec);
check(
  "context_read 单个 number 也接受",
  readSingle.ok === true &&
    readSingle.items.length === 1 &&
    readSingle.items[0].seq === 20 &&
    readSingle.items[0].text === "I will inspect the needle in step one." &&
    readSingle.items[0].kind === "assistant" &&
    readSingle.items[0].time === 200,
  JSON.stringify(readSingle),
);

const missingSeq = await readDef.execute({ seqs: [20, 999] }, exec);
check(
  "context_read 不存在 seq → 结构化 missing-seq（不部分返回）",
  failWith(missingSeq, "missing-seq"),
  JSON.stringify(missingSeq),
);

const noSession = await searchDef.execute(
  { query: "anything" },
  execFor(undefined),
);
check(
  "无 exec.agent.session → 结构化 no-agent-session",
  failWith(noSession, "no-agent-session"),
  JSON.stringify(noSession),
);

// ---------- 只读纪律 ----------
check(
  "搜索/读取后 events 与 session 完全未变",
  JSON.stringify(events) === eventsSnapshot && JSON.stringify(session) === sessionSnapshot,
);

const rendered = searchDef.output.render(
  { query: "needle" },
  { ok: true, page: [], total: 0, hasMore: false },
);
check(
  "output.render 输出 JSON 文本块",
  Array.isArray(rendered) &&
    rendered.length === 1 &&
    rendered[0].type === "text" &&
    typeof rendered[0].text === "string" &&
    JSON.parse(rendered[0].text).ok === true,
  JSON.stringify(rendered),
);

// ---------- 注销 ----------
if (typeof cleanup === "function") {
  cleanup();
}
check("ctx.effect cleanup 注销两个工具", disposedCount === 2, String(disposedCount));

console.log(
  `\nprobe-context-tools: ${passed}/${passed + failures} PASS${failures ? `, ${failures} FAIL` : ""}`,
);
process.exitCode = failures === 0 ? 0 : 1;
