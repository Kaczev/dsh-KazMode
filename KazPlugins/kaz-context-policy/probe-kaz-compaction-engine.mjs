// kaz-context-policy M3 探针：kaz-compaction-engine（离线 provider）
// ===========================================================================
// 验证：
//   ① 导出/继承/默认配置
//   ② selectKazRange：真实 session/tokenMeter 映射后选区正确
//   ③ compactIfNeeded(pressure)：阈值触发 → compactRegion 调用形状
//   ④ 低于阈值 / 无可压区 → 无兜底 null
//   ⑤ compactIfNeeded(context-overflow)：强制兜底与关闭 fallback 行为
//   ⑥ 真实 inherited compactRegion + stub summarize：摘要回调与结果形状
//   ⑦ 配置错误
//
// 运行：node KazPlugins/kaz-context-policy/probe-kaz-compaction-engine.mjs
// 仓库无 node_modules，因此引擎用 profile 镜像绝对路径导入（既有探针模式）。
// ===========================================================================

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { selectCompressRange } from "./lib/select-compress-range.js";

const PROFILE_PKG = "C:/Users/Kaczev/.dsh/profiles/web/package.json";
const PROFILE_ENGINE =
  "C:/Users/Kaczev/.dsh/profiles/web/KazPlugins/kaz-context-policy/lib/kaz-compaction-engine.js";
const profileRequire = createRequire(PROFILE_PKG);
const engineUrl = pathToFileURL(PROFILE_ENGINE).href;
const basicUrl = pathToFileURL(
  profileRequire.resolve("@deepseek-ai/dsh-compaction-basic"),
).href;

const [{ KazCompactionEngine, KAZ_CONFIG_DEFAULTS, normalizeKazConfig, selectKazRange }, basicMod] =
  await Promise.all([import(engineUrl), import(basicUrl)]);

let passed = 0;
let failures = 0;

const check = (label, ok, detail = "") => {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed += 1;
  else failures += 1;
};

const textMessage = (role, text) => ({
  role,
  content: [{ type: "text", text }],
});

const surfaceEvent = (seq, type, data, surfaceOp = "append") => {
  const event = { seq, type, data };
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
  return event;
};

const userEvent = (seq, text, surfaceOp = "append") =>
  surfaceEvent(seq, "user/message", textMessage("user", text), surfaceOp);

const assistantEvent = (seq, text, surfaceOp = "append") =>
  surfaceEvent(seq, "assistant/message", { message: textMessage("assistant", text) }, surfaceOp);

function makeSession(events, surfaceNodes, headerConfig = {}) {
  const eventList = events.slice();
  const nodes = surfaceNodes !== undefined ? surfaceNodes.slice() : eventList.map((e) => e.seq);
  const surface = { nodes, replaceGeneration: 0 };
  return {
    events: eventList,
    surface,
    headerConfig,
    requestHeader() {
      return {
        config: { provider: "deepseek", model: "deepseek-chat" },
        system: "SYSTEM_PROMPT",
        tools: [{ name: "read_file" }],
        ...headerConfig,
      };
    },
    deriveEventMessage(event) {
      if (event.type === "user/message") return event.data;
      if (event.type === "assistant/message" || event.type === "tool/result") {
        return event.data && event.data.message ? event.data.message : null;
      }
      return null;
    },
  };
}

function measurementFor(session, tokenMap, { low = false, lowTotal = 0 } = {}) {
  const nodes = session.surface.nodes.map((seq) => ({
    seq,
    tokens: Object.prototype.hasOwnProperty.call(tokenMap, seq) ? tokenMap[seq] : 1,
  }));
  const totalTokens = low
    ? lowTotal
    : nodes.reduce((sum, node) => sum + node.tokens, 0);
  return {
    logRevision: session.events.length,
    baseline: { kind: "estimated", tokens: 0 },
    surfaceDeltaTokens: 0,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes,
  };
}

function makeMeter(tokenMap, { low = false, lowTotal = 0 } = {}) {
  const state = { low, lowTotal };
  return {
    measure(session) {
      return measurementFor(session, tokenMap, {
        low: state.low,
        lowTotal: state.lowTotal,
      });
    },
    estimateMessage() {
      return 5;
    },
    setLow(value) {
      state.low = value;
    },
  };
}

function makeCtx(meter, llm) {
  const provided = [];
  return {
    logger: { info() {}, warn() {}, debug() {} },
    reflect: {
      provide(name, instance) {
        provided.push({ name, instance });
      },
    },
    tokenMeter: meter,
    llm,
    get() {
      return undefined;
    },
    on() {
      return () => {};
    },
    effect() {},
    _provided: provided,
  };
}

const agentFor = (session) => ({
  session,
  options: { provider: "deepseek", model: "deepseek-chat" },
});

const stubCompactionResult = (start, end) => ({
  compactionId: `probe-${start}-${end}`,
  startSeq: 900,
  summarySeq: 901,
  endSeq: 902,
  summary: [{ type: "text", text: "PROBE SUMMARY" }],
  shadowedRange: { start, end },
  shadowedSeqs: [start, end],
  shadowedTokenCount: 10,
});

function throws(label, fn, messagePart) {
  let message = "";
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(
    label,
    message.length > 0 && (messagePart === undefined || message.includes(messagePart)),
    message ? `threw: ${message}` : "did not throw",
  );
}

// ---------- ① 导出/继承/默认配置 ----------
{
  check("① 导出 KazCompactionEngine 类", typeof KazCompactionEngine === "function");
  check(
    "① 继承 BasicCompactionEngine（ctx.compaction Service）",
    basicMod.BasicCompactionEngine && KazCompactionEngine.prototype instanceof basicMod.BasicCompactionEngine,
  );
  const norm = normalizeKazConfig({});
  check(
    "① 默认 Kaz 配置与 M1 常量一致",
    norm.preservePrefixTokens === 4096 &&
      norm.preserveTailTokens === 8192 &&
      norm.maxFoldTokens === 8192 &&
      norm.useMeterTokens === true &&
      norm.overflowFallback === true &&
      Array.isArray(norm.layerPriority) &&
      norm.layerPriority.length === 4,
    JSON.stringify(KAZ_CONFIG_DEFAULTS),
  );
}

// ---------- ② selectKazRange：meter 映射后选区正确 ----------
{
  const events = [
    userEvent(10, "u-core-10"),
    userEvent(20, "u-active-20"),
    assistantEvent(30, "a-detail-30"),
    assistantEvent(40, "a-detail-40"),
    userEvent(50, "u-core-tail-50"),
  ];
  const session = makeSession(events, [10, 20, 30, 40, 50]);
  const tokenMap = { 10: 10, 20: 1000, 30: 10, 40: 1000, 50: 10 };
  const measurement = measurementFor(session, tokenMap);
  const r = selectKazRange(session, measurement, {
    preservePrefixTokens: 10,
    preserveTailTokens: 10,
    maxFoldTokens: 100,
  });
  check(
    "② meter 映射后只压中间小 detail（seq 30）",
    r.ok === true &&
      r.unitStart === 2 &&
      r.unitEnd === 2 &&
      r.startSeq === 30 &&
      r.endSeq === 30,
    JSON.stringify(r),
  );
  check(
    "② shadowedTokens/cache/tail 用 meter 价格",
    r.ok === true &&
      r.shadowedTokens === 10 &&
      r.cachePreservedTokens === 1010 &&
      r.tailPreservedTokens === 1010,
    JSON.stringify({ shadowedTokens: r.shadowedTokens, cache: r.cachePreservedTokens, tail: r.tailPreservedTokens }),
  );
  const unitsBefore = selectCompressRange([
    { seqStart: 10, seqEnd: 10, tokens: 1, layer: "core-task" },
    { seqStart: 20, seqEnd: 20, tokens: 1, layer: "active-detail" },
    { seqStart: 30, seqEnd: 30, tokens: 1, layer: "detail" },
    { seqStart: 40, seqEnd: 40, tokens: 1, layer: "detail" },
    { seqStart: 50, seqEnd: 50, tokens: 1, layer: "core-task" },
  ], { preservePrefixTokens: 1, preserveTailTokens: 1 });
  check("② M1 纯函数仍是同一选区的参照", unitsBefore.ok === true && unitsBefore.unitStart === 2);
}

// ---------- ③ pressure：阈值以上 → compactRegion 调用形状 ----------
{
  const events = [
    userEvent(10, "u-core-10"),
    userEvent(20, "u-active-20"),
    assistantEvent(30, "a-detail-30"),
    assistantEvent(40, "a-detail-40"),
    userEvent(50, "u-core-tail-50"),
  ];
  const session = makeSession(events, [10, 20, 30, 40, 50]);
  const tokenMap = { 10: 10, 20: 1000, 30: 10, 40: 1000, 50: 10 };
  const meter = makeMeter(tokenMap);
  const llm = {
    async resolveModelInfo() {
      return { context: { contextWindow: 1000 } };
    },
  };
  const ctx = makeCtx(meter, llm);
  const engine = new KazCompactionEngine(ctx, {
    thresholdRatio: 0.5,
    auto: false,
    preservePrefixTokens: 10,
    preserveTailTokens: 10,
    maxFoldTokens: 100,
  });
  const calls = [];
  engine.compactRegion = async (start, end, agent, signal) => {
    calls.push({ start, end, agent, signal });
    meter.setLow(true);
    return stubCompactionResult(start, end);
  };
  const agent = agentFor(session);
  const signal = new AbortController().signal;
  const result = await engine.compactIfNeeded(agent, "pressure", signal);
  check(
    "③ pressure 命中阈值并调用 compactRegion(30,30,agent,signal)",
    result !== null && calls.length === 1 && calls[0].start === 30 && calls[0].end === 30 && calls[0].agent === agent && calls[0].signal === signal,
    JSON.stringify({ calls }),
  );
  check(
    "③ compactIfNeeded 返回 compactRegion 结果形状",
    result !== null &&
      typeof result.compactionId === "string" &&
      result.shadowedRange &&
      result.shadowedSeqs,
    JSON.stringify(result),
  );
}

// ---------- ④ 低阈值 / 无可压区 → 无兜底 null ----------
{
  const session = makeSession(
    [userEvent(10, "low"), assistantEvent(20, "low")],
    [10, 20],
  );
  const meter = makeMeter({ 10: 10, 20: 20 });
  const llm = {
    async resolveModelInfo() {
      return { context: { contextWindow: 1000 } };
    },
  };
  const ctx = makeCtx(meter, llm);
  const engine = new KazCompactionEngine(ctx, {
    thresholdRatio: 0.9,
    auto: false,
    preservePrefixTokens: 0,
    preserveTailTokens: 0,
    maxFoldTokens: 100,
  });
  const calls = [];
  engine.compactRegion = async (start, end, agent, signal) => {
    calls.push({ start, end });
    return stubCompactionResult(start, end);
  };
  const lowResult = await engine.compactIfNeeded(agentFor(session), "pressure", new AbortController().signal);
  check("④ 低于阈值返回 null 且不调 compactRegion", lowResult === null && calls.length === 0);

  const session2 = makeSession(
    [userEvent(10, "only"), assistantEvent(20, "only")],
    [10, 20],
  );
  const meter2 = makeMeter({ 10: 1000, 20: 1000 });
  const ctx2 = makeCtx(meter2, llm);
  const engine2 = new KazCompactionEngine(ctx2, {
    thresholdRatio: 0.5,
    auto: false,
    preservePrefixTokens: Number.MAX_SAFE_INTEGER,
    preserveTailTokens: Number.MAX_SAFE_INTEGER,
    maxFoldTokens: 100,
  });
  const calls2 = [];
  engine2.compactRegion = async (start, end, agent, signal) => {
    calls2.push({ start, end });
    return stubCompactionResult(start, end);
  };
  const noRange = await engine2.compactIfNeeded(agentFor(session2), "pressure", new AbortController().signal);
  check("④ 无可压区返回 null 且不调 compactRegion", noRange === null && calls2.length === 0);
}

// ---------- ⑤ overflow：强制兜底与 overflowFallback=false ----------
{
  const session = makeSession([userEvent(10, "huge")], [10]);
  const tokenMap = { 10: 10000 };
  const meter = makeMeter(tokenMap);
  const ctx = makeCtx(meter, undefined);
  const engine = new KazCompactionEngine(ctx, {
    auto: false,
    preservePrefixTokens: 4096,
    preserveTailTokens: 8192,
    maxFoldTokens: 1, // 正常 staged 装不下 10000-token 单 unit
    overflowFallback: true,
  });
  const calls = [];
  engine.compactRegion = async (start, end, agent, signal) => {
    calls.push({ start, end, agent, signal });
    return stubCompactionResult(start, end);
  };
  const overflowResult = await engine.compactIfNeeded(agentFor(session), "context-overflow", new AbortController().signal);
  check(
    "⑤ overflow 触发零保护 fallback 并调用 compactRegion",
    overflowResult !== null && calls.length === 1 && calls[0].start === 10 && calls[0].end === 10,
    JSON.stringify({ calls }),
  );

  const ctx2 = makeCtx(meter, undefined);
  const engine2 = new KazCompactionEngine(ctx2, {
    auto: false,
    preservePrefixTokens: 4096,
    preserveTailTokens: 8192,
    maxFoldTokens: 1,
    overflowFallback: false,
  });
  const calls2 = [];
  engine2.compactRegion = async (start, end, agent, signal) => {
    calls2.push({ start, end });
    return stubCompactionResult(start, end);
  };
  const noFallback = await engine2.compactIfNeeded(agentFor(session), "context-overflow", new AbortController().signal);
  check("⑤ overflowFallback=false 无可压时返回 null", noFallback === null && calls2.length === 0);
}

// ---------- ⑥ 真实 inherited compactRegion：stub summarize 回调与结果 ----------
{
  // DshLike 会话：seq0=turn/start，surface=[1..6]，全程无工具调用、配对平衡。
  const seed = [
    surfaceEvent(0, "turn/start", { turn: 1 }),
    userEvent(1, "task: keep prefix"),
    assistantEvent(2, "assistant plan"),
    userEvent(3, "middle detail"),
    assistantEvent(4, "assistant more"),
    userEvent(5, "tail detail"),
    assistantEvent(6, "assistant final"),
  ];
  const events = seed.slice();
  const nodes = [1, 2, 3, 4, 5, 6];
  const surface = { nodes, replaceGeneration: 0 };
  const session = {
    events,
    surface,
    requestHeader() {
      return {
        config: { provider: "deepseek", model: "deepseek-chat" },
        system: "SYS",
        tools: [{ name: "read_file" }],
      };
    },
    append(type, data, opts) {
      const seq = events.length;
      const event = { seq, type, data };
      if (opts && opts.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp;
      if (opts && opts.sourceEventSeqs !== undefined) {
        event.sourceEventSeqs = opts.sourceEventSeqs.slice();
      }
      if (["user/message", "assistant/message", "tool/result"].includes(type)) {
        const op = event.surfaceOp;
        if (op === "append") {
          if (!nodes.includes(seq)) nodes.push(seq);
        } else if (op && op.op === "replace") {
          const startIdx = nodes.indexOf(op.start);
          const endIdx = nodes.indexOf(op.end);
          if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
            throw new Error(`probe session: bad replace ${op.start}..${op.end}`);
          }
          nodes.splice(startIdx, endIdx - startIdx + 1, seq);
          surface.replaceGeneration += 1;
        } else {
          throw new Error(`probe session: surface event missing valid surfaceOp`);
        }
      }
      events.push(event);
      return event;
    },
    deriveEventMessage(event) {
      if (event.type === "user/message") return event.data;
      if (event.type === "assistant/message" || event.type === "tool/result") {
        return event.data && event.data.message ? event.data.message : null;
      }
      return null;
    },
    id: "probe-session-compact-region",
  };

  const tokenMap = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600 };
  const meter = makeMeter(tokenMap);
  const ctx = makeCtx(meter, undefined);
  const engine = new KazCompactionEngine(ctx, { auto: false });

  const summaryCalls = [];
  engine.summarize = async (input, agent, signal) => {
    summaryCalls.push({ input, agent, signal });
    return {
      summary: [{ type: "text", text: "KAZ CHECKPOINT" }],
      rawOutput: [{ type: "text", text: "KAZ CHECKPOINT" }],
      llmStreamCall: false,
      provider: "deepseek",
      model: "deepseek-chat",
    };
  };

  const agent = agentFor(session);
  const signal = new AbortController().signal;
  const result = await engine.compactRegion(2, 4, agent, signal);
  check(
    "⑥ compactRegion 提交后返回官方结果形状",
    result &&
      typeof result.compactionId === "string" &&
      typeof result.startSeq === "number" &&
      typeof result.summarySeq === "number" &&
      typeof result.endSeq === "number" &&
      Array.isArray(result.shadowedSeqs) &&
      result.shadowedRange.start === 2 &&
      result.shadowedRange.end === 4 &&
      result.shadowedTokenCount === 900,
    JSON.stringify(result),
  );
  check(
    "⑥ 摘要回调收到 SummarizationInput 形状（system/tools/messages 长度 3）",
    summaryCalls.length === 1 &&
      summaryCalls[0].input &&
      summaryCalls[0].input.system === "SYS" &&
      Array.isArray(summaryCalls[0].input.tools) &&
      Array.isArray(summaryCalls[0].input.messages) &&
      summaryCalls[0].input.messages.length === 3 &&
      summaryCalls[0].agent === agent &&
      summaryCalls[0].signal === signal,
    JSON.stringify({ summaryCallCount: summaryCalls.length }),
  );
  check(
    "⑥ 压缩替换已写入 surface（seq2..4 → checkpoint node）",
    session.surface.nodes.length === 4 &&
      !session.surface.nodes.includes(2) &&
      !session.surface.nodes.includes(3) &&
      !session.surface.nodes.includes(4) &&
      session.surface.replaceGeneration === 1,
    JSON.stringify({ nodes: session.surface.nodes, generation: session.surface.replaceGeneration }),
  );
}

// ---------- ⑦ 配置错误 ----------
{
  const meter = makeMeter({});
  const ctx = makeCtx(meter, undefined);
  throws("⑦ preservePrefixTokens 负数抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, preservePrefixTokens: -1 });
  }, "preservePrefixTokens");
  throws("⑦ preserveTailTokens 非整数抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, preserveTailTokens: 1.5 });
  }, "preserveTailTokens");
  throws("⑦ maxFoldTokens 0 抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, maxFoldTokens: 0 });
  }, "maxFoldTokens");
  throws("⑦ layerPriority 非法层抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, layerPriority: ["bogus"] });
  }, "layerPriority");
  throws("⑦ layerPriority 重复抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, layerPriority: ["noise", "noise"] });
  }, "layerPriority");
  throws("⑦ 未知配置键抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, preservePrefixTokens: 1, typo: 1 });
  }, "unknown key");
  throws("⑦ protectedUnitIds 非数组抛错", () => {
    new KazCompactionEngine(ctx, { auto: false, protectedUnitIds: "keep" });
  }, "protectedUnitIds");
}

console.log("");
console.log(`probe-kaz-compaction-engine: ${passed} PASS, ${failures} FAIL`);
if (failures > 0) process.exitCode = 1;
