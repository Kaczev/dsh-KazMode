// kaz-context-policy M3.1 探针：session-context-adapter
// 运行：node KazPlugins/kaz-context-policy/probe-session-context-adapter.mjs
import {
  DEFAULT_LARGE_TOOL_RESULT_CHARS,
  buildCompressUnits,
  buildSearchRecords,
  deriveMessage,
  estimateTokens,
  foldSurfaceNodes,
  groupUnits,
  layerOf,
  textOfMessage,
} from "./lib/session-context-adapter.js";
import { selectCompressRange } from "./lib/select-compress-range.js";

let passed = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed += 1;
  else failures += 1;
};

const ev = (seq, type, data, surfaceOp = "append", time) => {
  const event = { seq, type, data };
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
  if (time !== undefined) event.time = time;
  return event;
};

const textContent = (text) => [{ type: "text", text }];
const userMessage = (text) => ({ role: "user", content: textContent(text) });
const assistantMessage = (content) => ({ role: "assistant", content });
const toolResultMessage = (text) => ({
  role: "user",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      content: textContent(text),
    },
  ],
});

// ---------- ① deriveMessage 镜像 DSH surface.js 投影 ----------
{
  const userDirect = ev(1, "user/message", "plain user text");
  const userMsg = ev(2, "user/message", userMessage("hello"));
  const assistant = ev(
    3,
    "assistant/message",
    { message: assistantMessage([{ type: "text", text: "hi" }]) },
  );
  const emptyAssistant = ev(
    4,
    "assistant/message",
    { message: assistantMessage([]) },
  );
  const toolResult = ev(5, "tool/result", { message: toolResultMessage("ok") });
  const boundary = ev(6, "turn/start", { turn: 1 });
  check(
    "① user/message → event.data 原样",
    deriveMessage(userDirect) === "plain user text" &&
      deriveMessage(userMsg) === userMsg.data,
  );
  check(
    "① assistant/message → event.data.message",
    deriveMessage(assistant) === assistant.data.message,
  );
  check(
    "① assistant 空 content → null",
    deriveMessage(emptyAssistant) === null,
  );
  check(
    "① tool/result → event.data.message",
    deriveMessage(toolResult) === toolResult.data.message,
  );
  check(
    "① 非 surface 事件 → null",
    deriveMessage(boundary) === null,
  );
}

// ---------- ② textOfMessage 边界 ----------
{
  check(
    "② string 直接返回",
    textOfMessage("plain") === "plain",
  );
  check(
    "② content[] text 拼接",
    textOfMessage({
      content: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    }) === "AB",
  );
  check(
    "② tool-call block → [tool-call name] args",
    textOfMessage({
      content: [
        {
          type: "tool-call",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
      ],
    }) === '[tool-call read_file] {"path":"a.txt"}',
  );
  check(
    "② tool-result 递归取内层 text",
    textOfMessage({
      content: [
        {
          type: "tool-result",
          content: [{ type: "text", text: "inner" }],
        },
      ],
    }) === "inner",
  );
}

// ---------- ③ buildSearchRecords：append-origin / 排除 replacement / compaction ----------
{
  const events = [
    ev(40, "compaction/summary", { shadowedSeqs: [10, 20] }),
    ev(10, "user/message", "first", "append", "t-10"),
    ev(20, "assistant/message", { message: assistantMessage(textContent("second")) }, "append"),
    ev(30, "tool/result", { message: toolResultMessage("third") }, "append"),
    ev(50, "user/message", userMessage("checkpoint"), {
      op: "replace",
      start: 10,
      end: 20,
    }),
    ev(60, "tool/result", { message: toolResultMessage("rewritten") }, {
      op: "replace",
      start: 30,
      end: 30,
    }),
    ev(70, "turn/start", { turn: 1 }),
  ];
  const records = buildSearchRecords(events);
  check(
    "③ records 排除 replacement checkpoint / compaction/* / 非 surface，保留原文 seq 升序",
    records.length === 3 &&
      JSON.stringify(records.map((r) => r.seq)) === "[10,20,30]" &&
      records.map((r) => r.kind).join(",") === "user,assistant,tool",
    JSON.stringify(records.map((r) => [r.seq, r.kind])),
  );
  check(
    "③ records 字段 text/time 正确透传",
    records[0].text === "first" &&
      records[0].time === "t-10" &&
      records[1].text === "second" &&
      records[2].text === "third" &&
      !("time" in records[1]),
    JSON.stringify(records),
  );
  check(
    "③ 空 assistant / 空白文本不产生 record",
    (() => {
      const empty = buildSearchRecords([
        ev(1, "assistant/message", { message: assistantMessage([]) }, "append"),
        ev(2, "user/message", "   ", "append"),
        ev(3, "user/message", "real", "append"),
      ]);
      return empty.length === 1 && empty[0].seq === 3;
    })(),
  );
}

// ---------- ④ units 当前 surface 顺序 position（含头部 checkpoint 替换） ----------
{
  const events = [
    ev(100, "user/message", userMessage("old task"), "append"),
    ev(101, "assistant/message", { message: assistantMessage(textContent("old detail")) }, "append"),
    ev(102, "user/message", userMessage("followup"), "append"),
    ev(200, "user/message", userMessage("CHECKPOINT"), {
      op: "replace",
      start: 100,
      end: 101,
    }),
    ev(201, "assistant/message", { message: assistantMessage(textContent("tail")) }, "append"),
  ];
  const session = { events, surface: { nodes: [200, 102, 201] } };
  const units = buildCompressUnits(session);
  check(
    "④ units 顺序 = surface.nodes 顺序；position 0/1/2，seqStart 200/102/201",
    units.length === 3 &&
      JSON.stringify(units.map((u) => u.position)) === "[0,1,2]" &&
      JSON.stringify(units.map((u) => u.seqStart)) === "[200,102,201]",
    JSON.stringify(units),
  );
  check(
    "④ surface 缺省时最小折叠得到同一 nodes 顺序",
    JSON.stringify(foldSurfaceNodes(events)) === "[200,102,201]",
    JSON.stringify(foldSurfaceNodes(events)),
  );
  check(
    "④ 头部 checkpoint（第一 user）默认 core-task、其后 user active-detail、assistant detail",
    units[0].layer === "core-task" &&
      units[1].layer === "active-detail" &&
      units[2].layer === "detail",
    JSON.stringify(units.map((u) => u.layer)),
  );
  const selected = selectCompressRange(units, {
    preservePrefixTokens: 0,
    preserveTailTokens: 0,
    maxFoldTokens: 1000,
    layerPriority: ["active-detail", "detail", "core-task", "noise"],
  });
  check(
    "④ adapter + selectCompressRange 集成：position 排序后选到 seq102 active-detail",
    selected.ok === true &&
      selected.unitStart === 1 &&
      selected.unitEnd === 1 &&
      selected.startSeq === 102 &&
      selected.endSeq === 102,
    JSON.stringify(selected),
  );
}

// ---------- ⑤ 平衡分组不拆 assistant tool-call 与 tool/result ----------
{
  const events = [
    ev(0, "user/message", userMessage("task"), "append"),
    ev(
      1,
      "assistant/message",
      {
        message: assistantMessage([
          { type: "text", text: "calling" },
          { type: "tool-call", name: "bash", arguments: '{"cmd":"ls"}' },
        ]),
      },
      "append",
    ),
    ev(2, "tool/result", { message: toolResultMessage("output") }, "append"),
    ev(3, "assistant/message", { message: assistantMessage(textContent("done")) }, "append"),
    ev(4, "user/message", userMessage("next"), "append"),
  ];
  const units = buildCompressUnits({ events });
  check(
    "⑤ tool-call/result 并入同一 unit：seqStart=1 seqEnd=2",
    units.length === 4 &&
      units[1].seqStart === 1 &&
      units[1].seqEnd === 2 &&
      units[0].seqStart === 0 &&
      units[0].seqEnd === 0 &&
      units[2].seqStart === 3 &&
      units[3].seqStart === 4,
    JSON.stringify(units),
  );
  check(
    "⑤ unit position 仍 0..3 连续且唯一",
    JSON.stringify(units.map((u) => u.position)) === "[0,1,2,3]",
    JSON.stringify(units.map((u) => u.position)),
  );
  check(
    "⑤ 小工具对按 assistant/detail 归层（不因小结果变 noise）",
    units[1].layer === "detail",
    JSON.stringify(units.map((u) => u.layer)),
  );
}

// ---------- ⑥ layer 启发式与 largeToolResultChars 可调 ----------
{
  const smallTool = "ok";
  const largeTool = "x".repeat(5000);
  const events = [
    ev(1, "user/message", userMessage("task"), "append"),
    ev(2, "user/message", userMessage("followup"), "append"),
    ev(3, "assistant/message", { message: assistantMessage(textContent("explain")) }, "append"),
    ev(4, "tool/result", { message: toolResultMessage(smallTool) }, "append"),
    ev(5, "tool/result", { message: toolResultMessage(largeTool) }, "append"),
  ];
  const units = buildCompressUnits({ events });
  check(
    "⑥ 第一 user core-task / 第二 user active-detail / assistant detail",
    units[0].layer === "core-task" &&
      units[1].layer === "active-detail" &&
      units[2].layer === "detail",
    JSON.stringify(units.map((u) => u.layer)),
  );
  check(
    "⑥ 小工具结果默认 detail；>4096 字符工具结果 noise",
    units[3].layer === "detail" &&
      units[4].layer === "noise",
    JSON.stringify(units.map((u) => [u.seqStart, u.layer])),
  );
  const configured = buildCompressUnits(
    { events },
    { largeToolResultChars: 10000 },
  );
  check(
    "⑥ largeToolResultChars=10000 时 5000 字符结果不再是 noise",
    configured[4].layer === "detail",
    JSON.stringify(configured.map((u) => [u.seqStart, u.layer])),
  );
  check(
    "⑥ 默认常量 DEFAULT_LARGE_TOOL_RESULT_CHARS=4096",
    DEFAULT_LARGE_TOOL_RESULT_CHARS === 4096,
  );
}

// ---------- ⑦ estimateTokens / layerOf / groupUnits 纯 helper ----------
{
  check(
    "⑦ estimateTokens：''=0，4 字符=1，5 字符=2",
    estimateTokens("") === 0 &&
      estimateTokens("abcd") === 1 &&
      estimateTokens("abcde") === 2,
  );
  check(
    "⑦ layerOf(user, {isFirstUser:true}) 默认 core-task；普通 user 默认 active-detail",
    layerOf(ev(1, "user/message", userMessage("x")), { isFirstUser: true }) === "core-task" &&
      layerOf(ev(2, "user/message", userMessage("x"))) === "active-detail",
  );
  check(
    "⑦ layerOf(tool/result) 超阈值 noise、普通 detail",
    layerOf(ev(1, "tool/result", { message: toolResultMessage("x".repeat(5000)) })) === "noise" &&
      layerOf(ev(2, "tool/result", { message: toolResultMessage("ok") })) === "detail",
  );
  const grouped = groupUnits([
    { seq: 1, type: "user/message", text: "task", chars: 4 },
    {
      seq: 2,
      type: "assistant/message",
      text: "call",
      chars: 4,
      toolCallCount: 1,
      layer: "detail",
    },
    { seq: 3, type: "tool/result", text: "out", chars: 3, layer: "detail" },
  ]);
  check(
    "⑦ groupUnits 直接调用也输出配对平衡 M1 unit",
    grouped.length === 2 &&
      grouped[0].seqStart === 1 &&
      grouped[0].seqEnd === 1 &&
      grouped[1].seqStart === 2 &&
      grouped[1].seqEnd === 3 &&
      grouped[1].tokens === 2,
    JSON.stringify(grouped),
  );
}

console.log(
  `\nprobe-session-context-adapter: ${passed}/${passed + failures} PASS${failures ? `, ${failures} FAIL` : ""}`,
);
process.exitCode = failures === 0 ? 0 : 1;
