// kaz-context-policy M2 探针：context-search-read 纯函数核心
// 运行：node KazPlugins/kaz-context-policy/probe-context-search-read.mjs
import {
  DEFAULT_READ_CHARS_BUDGET,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SNIPPET_AFTER,
  DEFAULT_SNIPPET_BEFORE,
  estimateChars,
  readContext,
  searchContext,
  tokenOfText,
} from "./lib/context-search-read.js";

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

// ---------- ① 子串命中：大小写不敏感、seq 降序、time 透传 ----------
{
  const records = [
    { seq: 10, kind: "tool", time: "t-10", text: "The quick brown Fox jumps" },
    { seq: 20, kind: "assistant", time: 200, text: "A FOX named Rex" },
    { seq: 30, kind: "user", text: "foxes are small but fast" },
  ];
  const r = searchContext(records, "FOX");
  check(
    "① FOX 大小写不敏感命中 3 条，page 按 seq 降序 30/20/10",
    r.ok === true &&
      r.total === 3 &&
      r.page.length === 3 &&
      r.page[0].seq === 30 &&
      r.page[1].seq === 20 &&
      r.page[2].seq === 10 &&
      r.page[2].kind === "tool" &&
      r.page[2].time === "t-10" &&
      r.page[0].time === undefined,
    JSON.stringify(r.page.map((x) => x.seq)),
  );
  check(
    "① 跨词子串 QUICK BROWN 只命中 seq10",
    (() => {
      const hit = searchContext(records, "QUICK BROWN");
      return (
        hit.ok === true && hit.total === 1 && hit.page[0].seq === 10
      );
    })(),
  );
  check(
    "① snippet 保留原文大小写并含命中",
    r.ok === true &&
      r.page[2].snippet.includes("Fox") &&
      r.page[0].snippet.includes("foxes"),
    JSON.stringify(r.page.map((x) => x.snippet)),
  );
}

// ---------- ② 无命中 ----------
{
  const records = [
    { seq: 1, kind: "user", text: "alpha beta" },
    { seq: 2, kind: "assistant", text: "gamma delta" },
  ];
  const r = searchContext(records, "omega", { limit: 2 });
  check(
    "② 无命中 → ok:true page=[] total=0 hasMore=false 无 nextCursor",
    r.ok === true &&
      r.page.length === 0 &&
      r.total === 0 &&
      r.hasMore === false &&
      !("nextCursor" in r),
    JSON.stringify(r),
  );
}

// ---------- ③ 分页 cursor + hasMore ----------
{
  const records = Array.from({ length: 12 }, (_, i) => ({
    seq: i + 1,
    kind: i % 2 === 0 ? "user" : "assistant",
    text: `message needle ${i + 1}`,
  }));
  const r1 = searchContext(records, "needle", { limit: 5 });
  check(
    "③ 第 1 页：5 条降序 12..8，total=12，hasMore=true，有 nextCursor",
    r1.ok === true &&
      r1.page.length === 5 &&
      JSON.stringify(r1.page.map((x) => x.seq)) === "[12,11,10,9,8]" &&
      r1.total === 12 &&
      r1.hasMore === true &&
      typeof r1.nextCursor === "string",
    JSON.stringify({ total: r1.total, cursor: r1.nextCursor }),
  );
  const r2 = searchContext(records, "needle", {
    limit: 5,
    cursor: r1.nextCursor,
  });
  check(
    "③ 第 2 页：cursor 续读 7..3，hasMore=true",
    r2.ok === true &&
      r2.page.length === 5 &&
      JSON.stringify(r2.page.map((x) => x.seq)) === "[7,6,5,4,3]" &&
      r2.total === 12 &&
      r2.hasMore === true &&
      typeof r2.nextCursor === "string",
    JSON.stringify(r2.page.map((x) => x.seq)),
  );
  const r3 = searchContext(records, "needle", {
    limit: 5,
    cursor: r2.nextCursor,
  });
  check(
    "③ 第 3 页：2..1，hasMore=false，无 nextCursor",
    r3.ok === true &&
      JSON.stringify(r3.page.map((x) => x.seq)) === "[2,1]" &&
      r3.total === 12 &&
      r3.hasMore === false &&
      !("nextCursor" in r3),
    JSON.stringify(r3),
  );
}

// ---------- ④ snippet 截窗与省略号 ----------
{
  const text = "a".repeat(100) + "KEYWORD" + "b".repeat(200);
  const records = [{ seq: 1, kind: "user", text }];
  const r = searchContext(records, "keyword", {
    snippetBefore: 80,
    snippetAfter: 160,
  });
  const snip = r.page[0].snippet;
  check(
    "④ 默认窗口截左右：… + 前80 + 命中 + 后160 + …",
    r.ok === true &&
      snip.startsWith("\u2026") &&
      snip.endsWith("\u2026") &&
      snip.includes("KEYWORD") &&
      snip.length === 1 + 80 + 7 + 160 + 1 &&
      snip.slice(1, -1).startsWith("a".repeat(80)) &&
      snip.slice(1, -1).endsWith("b".repeat(160)),
    `snippetLength=${snip.length}`,
  );
  const rFull = searchContext(records, "keyword", {
    snippetBefore: 500,
    snippetAfter: 500,
  });
  check(
    "④ 窗口足够大 → snippet 等于整条原文且无省略号",
    rFull.ok === true &&
      rFull.page[0].snippet === text &&
      !rFull.page[0].snippet.includes("\u2026"),
  );
  const rZero = searchContext(records, "keyword", {
    snippetBefore: 0,
    snippetAfter: 0,
  });
  check(
    "④ 前后窗口 0 → …KEYWORD…",
    rZero.ok === true && rZero.page[0].snippet === "\u2026KEYWORD\u2026",
    JSON.stringify(rZero.page[0].snippet),
  );
}

// ---------- ⑤ 输入校验：非法/空 query、空 records、非法 record 等 ----------
{
  const good = { seq: 1, kind: "user", text: "hello world" };
  const cases = [
    {
      label: "⑤ query 非 string → invalid-query",
      run: () => searchContext([good], 42),
      code: "invalid-query",
    },
    {
      label: "⑤ 空 query（trim 后空）→ empty-query",
      run: () => searchContext([good], "   "),
      code: "empty-query",
    },
    {
      label: "⑤ records 非数组 → invalid-records",
      run: () => searchContext({}, "x"),
      code: "invalid-records",
    },
    {
      label: "⑤ record 非 plain object → invalid-record",
      run: () => searchContext([null], "x"),
      code: "invalid-record",
    },
    {
      label: "⑤ 重复 seq → duplicate-seq",
      run: () =>
        searchContext(
          [
            { seq: 1, kind: "user", text: "a" },
            { seq: 1, kind: "assistant", text: "b" },
          ],
          "x",
        ),
      code: "duplicate-seq",
    },
    {
      label: "⑤ 非法 kind → invalid-kind",
      run: () =>
        searchContext([{ seq: 1, kind: "system", text: "a" }], "x"),
      code: "invalid-kind",
    },
    {
      label: "⑤ 空白 text → invalid-text",
      run: () =>
        searchContext([{ seq: 1, kind: "user", text: "   " }], "x"),
      code: "invalid-text",
    },
    {
      label: "⑤ limit=0 → invalid-limit",
      run: () => searchContext([good], "hello", { limit: 0 }),
      code: "invalid-limit",
    },
  ];
  for (const item of cases) {
    const r = item.run();
    check(item.label, failWith(r, item.code), r ? r.code : "no result");
  }
  const emptyCorpus = searchContext([], "hello");
  check(
    "⑤ 空 records 是合法空语料 → ok:true total=0",
    emptyCorpus.ok === true &&
      emptyCorpus.total === 0 &&
      emptyCorpus.page.length === 0,
    JSON.stringify(emptyCorpus),
  );
}

// ---------- ⑥ read 单个精确全文 ----------
{
  const longText = Array.from({ length: 4000 }, (_, i) => `line-${i}`).join("\n");
  const records = [
    { seq: 7, kind: "tool", time: "2026-01-02T03:04:05Z", text: longText },
  ];
  const r = readContext(records, 7, { totalCharsBudget: 100000 });
  check(
    "⑥ read 单条：整条原文、字段完整、不截断",
    r.ok === true &&
      r.items.length === 1 &&
      r.items[0].seq === 7 &&
      r.items[0].kind === "tool" &&
      r.items[0].time === "2026-01-02T03:04:05Z" &&
      r.items[0].text === longText &&
      r.items[0].text.length === longText.length &&
      r.omitted === 0,
    `textChars=${longText.length}`,
  );
}

// ---------- ⑦ read 多个：预算 omitted 与去重 ----------
{
  const records = [
    { seq: 1, kind: "user", text: "x".repeat(1000) },
    { seq: 2, kind: "assistant", text: "y".repeat(2000) },
    { seq: 3, kind: "tool", text: "z".repeat(3000) },
  ];
  const r = readContext(records, [2, 1, 2, 3], { totalCharsBudget: 2500 });
  check(
    "⑦ 输入 [2,1,2,3] 去重为 [2,1,3]；预算 2500 → 只回 seq2，omitted=2",
    r.ok === true &&
      r.items.length === 1 &&
      r.items[0].seq === 2 &&
      r.items[0].text === "y".repeat(2000) &&
      r.omitted === 2,
    JSON.stringify({ items: r.items.map((x) => x.seq), omitted: r.omitted }),
  );
  const rAll = readContext(records, [2, 1, 2, 3], { totalCharsBudget: 6500 });
  check(
    "⑦ 预算 6500 → 三条都回，顺序 2/1/3，omitted=0",
    rAll.ok === true &&
      JSON.stringify(rAll.items.map((x) => x.seq)) === "[2,1,3]" &&
      rAll.items[0].text === "y".repeat(2000) &&
      rAll.items[1].text === "x".repeat(1000) &&
      rAll.items[2].text === "z".repeat(3000) &&
      rAll.omitted === 0,
    JSON.stringify(rAll.items.map((x) => x.seq)),
  );
  const rEmptyTargets = readContext(records, []);
  check(
    "⑦ 空 targets → ok:true items=[] omitted=0",
    rEmptyTargets.ok === true &&
      rEmptyTargets.items.length === 0 &&
      rEmptyTargets.omitted === 0,
    JSON.stringify(rEmptyTargets),
  );
}

// ---------- ⑧ read 不存在/非法 seq 报错 ----------
{
  const records = [{ seq: 1, kind: "user", text: "hello" }];
  const missing = readContext(records, [999]);
  check(
    "⑧ 不存在 seq → ok:false missing-seq",
    failWith(missing, "missing-seq"),
    JSON.stringify(missing),
  );
  const invalidSeq = readContext(records, [1.5]);
  check(
    "⑧ 非安全整数 seq → ok:false invalid-target-seq",
    failWith(invalidSeq, "invalid-target-seq"),
    JSON.stringify(invalidSeq),
  );
  const invalidTargets = readContext(records, "1");
  check(
    "⑧ targets 类型非法 → ok:false invalid-targets",
    failWith(invalidTargets, "invalid-targets"),
    JSON.stringify(invalidTargets),
  );
  const missingInMulti = readContext(records, [1, 42]);
  check(
    "⑧ 多目标中含不存在 seq → missing-seq（不部分返回）",
    failWith(missingInMulti, "missing-seq"),
    JSON.stringify(missingInMulti),
  );
}

// ---------- ⑨ helper 纯函数一致性 ----------
{
  const sample = "Hello, world!  Kaz 上下文 12345";
  check(
    "⑨ estimateChars 返回确定字符数且纯函数一致",
    estimateChars(sample) === sample.length &&
      estimateChars(sample) === estimateChars(sample),
    String(estimateChars(sample)),
  );
  check(
    "⑨ tokenOfText 返回确定安全正整数且纯函数一致",
    Number.isSafeInteger(tokenOfText(sample)) &&
      tokenOfText(sample) > 0 &&
      tokenOfText(sample) === tokenOfText(sample),
    String(tokenOfText(sample)),
  );
  check(
    "⑨ tokenOfText('') = 0；tokenOfText 基于 estimateChars",
    tokenOfText("") === 0 &&
      tokenOfText("abcd") === 1 &&
      tokenOfText("abcde") === 2,
    String(tokenOfText("abcde")),
  );
  const records = [
    { seq: 1, kind: "user", text: "pure helper" },
    { seq: 2, kind: "assistant", text: "pure helper again" },
  ];
  const snapshot = JSON.stringify(records);
  searchContext(records, "helper");
  readContext(records, [1, 2], { totalCharsBudget: 1000 });
  check(
    "⑨ search/read 不修改输入 records",
    JSON.stringify(records) === snapshot,
  );
  check(
    "⑨ 默认常量符合契约 10/80/160/16000",
    DEFAULT_SEARCH_LIMIT === 10 &&
      DEFAULT_SNIPPET_BEFORE === 80 &&
      DEFAULT_SNIPPET_AFTER === 160 &&
      DEFAULT_READ_CHARS_BUDGET === 16000,
  );
}

console.log(
  `\nprobe-context-search-read: ${passed}/${passed + failures} PASS${failures ? `, ${failures} FAIL` : ""}`,
);
process.exitCode = failures === 0 ? 0 : 1;
