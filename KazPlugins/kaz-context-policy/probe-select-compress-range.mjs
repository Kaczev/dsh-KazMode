// kaz-context-policy M1 探针：select-compress-range 纯函数原型
// 运行：node KazPlugins/kaz-context-policy/probe-select-compress-range.mjs
import {
  DEFAULT_PRESERVE_PREFIX_TOKENS,
  DEFAULT_PRESERVE_TAIL_TOKENS,
  DEFAULT_MAX_FOLD_TOKENS,
  LAYER_PRIORITY_DEFAULT,
  selectCompressRange,
  findCompressibleIndexRange,
  estimateShadowedTokens,
  estimateCachePreservedTokens,
} from "./lib/select-compress-range.js";

let passed = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed += 1;
  else failures += 1;
};

const u = (seqStart, seqEnd, tokens, layer, id, position) => ({
  seqStart,
  seqEnd,
  tokens,
  layer,
  ...(id !== undefined ? { id } : {}),
  ...(position !== undefined ? { position } : {}),
});

// ---------- ① 默认保留前缀+尾：只压中间 noise ----------
{
  const units = [
    u(0, 2000, 2000, "core-task"),
    u(2000, 4000, 2000, "core-task"),
    u(4000, 6000, 2000, "noise"),
    u(6000, 8000, 2000, "detail"),
    u(8000, 10000, 2000, "active-detail"),
    u(10000, 13000, 3000, "detail"),
    u(13000, 14000, 1000, "core-task"),
  ];
  const r = selectCompressRange(units);
  check(
    "① 默认预算压缩中间 noise",
    r.ok === true &&
      r.unitStart === 2 &&
      r.unitEnd === 2 &&
      r.startSeq === 4000 &&
      r.endSeq === 6000,
    JSON.stringify({ unitStart: r.unitStart, unitEnd: r.unitEnd }),
  );
  check(
    "① token 估算 = 中间 noise 2000 / 左前缀 4000 / 右尾 8000",
    r.ok === true &&
      r.shadowedTokens === 2000 &&
      r.cachePreservedTokens === 4000 &&
      r.tailPreservedTokens === 8000,
    JSON.stringify({
      shadowedTokens: r.shadowedTokens,
      cachePreservedTokens: r.cachePreservedTokens,
      tailPreservedTokens: r.tailPreservedTokens,
    }),
  );
  check(
    "① 默认常量 = 4096/8192/8192/noise-detail-active-detail-core-task",
    DEFAULT_PRESERVE_PREFIX_TOKENS === 4096 &&
      DEFAULT_PRESERVE_TAIL_TOKENS === 8192 &&
      DEFAULT_MAX_FOLD_TOKENS === 8192 &&
      JSON.stringify(LAYER_PRIORITY_DEFAULT) ===
        JSON.stringify(["noise", "detail", "active-detail", "core-task"]),
  );
}

// ---------- ② 前缀预算大导致无可压区 ----------
{
  const units = [
    u(0, 100, 100, "core-task"),
    u(100, 200, 100, "noise"),
    u(200, 300, 100, "detail"),
  ];
  const r = selectCompressRange(units, {
    preservePrefixTokens: 10000,
    preserveTailTokens: 0,
  });
  check(
    "② 前缀预算覆盖全部 → ok:false no-compressible-range",
    r.ok === false && r.code === "no-compressible-range" && typeof r.reason === "string",
    r.code,
  );
}

// ---------- ③ staged：大中段只选一部份，不超 maxFoldTokens ----------
{
  const units = [
    u(0, 100, 100, "core-task"),
    u(100, 200, 100, "noise"),
    u(200, 300, 100, "noise"),
    u(300, 400, 100, "noise"),
    u(400, 500, 100, "noise"),
    u(500, 600, 100, "noise"),
    u(600, 700, 100, "noise"),
    u(700, 800, 100, "noise"),
    u(800, 900, 100, "noise"),
    u(900, 1000, 100, "noise"),
    u(1000, 1100, 100, "core-task"),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 300,
  };
  const r = selectCompressRange(units, opts);
  check(
    "③ 900 tokens noise 中段只压最右侧 300 → unitStart/unitEnd 7..9",
    r.ok === true &&
      r.unitStart === 7 &&
      r.unitEnd === 9 &&
      r.shadowedTokens === 300,
    JSON.stringify({ unitStart: r.unitStart, unitEnd: r.unitEnd, shadowedTokens: r.shadowedTokens }),
  );
  check(
    "③ staged 后左前缀保留 700、右尾保留 100",
    r.ok === true &&
      r.cachePreservedTokens === 700 &&
      r.tailPreservedTokens === 100,
    JSON.stringify({
      cachePreservedTokens: r.cachePreservedTokens,
      tailPreservedTokens: r.tailPreservedTokens,
    }),
  );
}

// ---------- ④ 层优先级：noise 优先于 detail ----------
{
  const units = [
    u(0, 100, 100, "core-task"),
    u(100, 200, 100, "detail"),
    u(200, 300, 100, "noise"),
    u(300, 400, 100, "core-task"),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 500,
  };
  const rDefault = selectCompressRange(units, opts);
  check(
    "④ 默认层序选 noise（startSeq=200）而非 detail",
    rDefault.ok === true &&
      rDefault.unitStart === 2 &&
      rDefault.startSeq === 200,
    JSON.stringify(rDefault),
  );
  const rCustom = selectCompressRange(units, {
    ...opts,
    layerPriority: ["detail", "noise"],
  });
  check(
    "④ 自定义层序 detail 优先 → 改选 detail（startSeq=100）",
    rCustom.ok === true &&
      rCustom.unitStart === 1 &&
      rCustom.startSeq === 100,
    JSON.stringify(rCustom),
  );
}

// ---------- ⑤ protectedUnitIds 按 unit.id 强制保护；缺 id 按排序后 0-based index ----------
{
  const units = [
    u(0, 100, 100, "core-task", "core-prefix"),
    u(100, 200, 100, "detail", "detail-mid"),
    u(200, 300, 100, "noise", "noise-mid"),
    u(300, 400, 100, "core-task", "core-tail"),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 500,
  };
  const r = selectCompressRange(units, {
    ...opts,
    protectedUnitIds: ["noise-mid"],
  });
  check(
    "⑤ noise-mid 被 protectedUnitIds 按 id 保护 → 不可压，改选 detail-mid",
    r.ok === true &&
      r.unitStart === 1 &&
      r.startSeq === 100 &&
      r.endSeq === 200 &&
      r.shadowedTokens === 100,
    JSON.stringify(r),
  );
  const rAllProtected = selectCompressRange(units, {
    ...opts,
    protectedUnitIds: ["detail-mid", "noise-mid"],
  });
  check(
    "⑤ 中间全部按 id 强制保护 → ok:false no-compressible-range",
    rAllProtected.ok === false &&
      rAllProtected.code === "no-compressible-range",
    rAllProtected.code,
  );
  const rIdNoIndexFallback = selectCompressRange(units, {
    ...opts,
    protectedUnitIds: ["2"], // noise-mid 的排序后 index 是 2，但它有 id → 只按 id 匹配
  });
  check(
    "⑤ 带 id 的 unit 不按 index 兜底 → noise-mid 仍可压",
    rIdNoIndexFallback.ok === true &&
      rIdNoIndexFallback.unitStart === 2 &&
      rIdNoIndexFallback.startSeq === 200 &&
      rIdNoIndexFallback.endSeq === 300 &&
      rIdNoIndexFallback.shadowedTokens === 100,
    JSON.stringify(rIdNoIndexFallback),
  );
}

// ---------- ⑤b 缺 id 时：按排序后 0-based index 保护 ----------
{
  // 故意乱序输入：noise 的原始 index 是 0，排序后 index 是 2。
  const units = [
    u(200, 300, 100, "noise"),
    u(0, 100, 100, "core-task"),
    u(100, 200, 100, "detail"),
    u(300, 400, 100, "core-task"),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 500,
    protectedUnitIds: ["2"], // 排序后 0-based index 保护 noise
  };
  const r = selectCompressRange(units, opts);
  check(
    "⑤b 缺 id 时 protectedUnitIds:[\"2\"] 按排序后 index 保护 → 改选 detail",
    r.ok === true &&
      r.unitStart === 1 &&
      r.startSeq === 100 &&
      r.endSeq === 200 &&
      r.shadowedTokens === 100,
    JSON.stringify(r),
  );
}

// ---------- ⑤c position 显式 surface 顺序 ----------
{
  // seqStart 乱序但与 position 冲突：position 顺序是 100→200→0→300。
  const units = [
    u(0, 100, 100, "noise", undefined, 2),
    u(100, 200, 100, "core-task", undefined, 0),
    u(200, 300, 100, "detail", undefined, 1),
    u(300, 400, 100, "core-task", undefined, 3),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 500,
  };
  const r = selectCompressRange(units, opts);
  check(
    "⑤c 乱 seqStart + position 有序：按 position 选到 seqStart=0 的 noise",
    r.ok === true &&
      r.unitStart === 2 &&
      r.unitEnd === 2 &&
      r.startSeq === 0 &&
      r.endSeq === 100 &&
      r.shadowedTokens === 100,
    JSON.stringify({ unitStart: r.unitStart, startSeq: r.startSeq }),
  );
  check(
    "⑤c position 与 seqStart 冲突：position 优先（seqStart 旧序会改选 detail 200）",
    r.ok === true &&
      r.startSeq === 0 &&
      r.unitStart === 2 &&
      r.endSeq === 100,
    JSON.stringify({ unitStart: r.unitStart, startSeq: r.startSeq }),
  );
  check(
    "⑤c 重复 position → ok:false duplicate-position",
    (() => {
      const dup = selectCompressRange(
        [
          u(0, 100, 10, "noise", undefined, 0),
          u(100, 200, 10, "detail", undefined, 0),
        ],
        opts,
      );
      return (
        dup.ok === false &&
        dup.code === "duplicate-position" &&
        typeof dup.reason === "string"
      );
    })(),
  );
  check(
    "⑤c 非法 position → ok:false invalid-position",
    (() => {
      const bad = selectCompressRange(
        [u(0, 100, 10, "noise", undefined, -1)],
        opts,
      );
      return (
        bad.ok === false &&
        bad.code === "invalid-position" &&
        typeof bad.reason === "string"
      );
    })(),
  );
}

// ---------- ⑥ helper 估算正确 ----------
{
  const units = [
    u(0, 100, 100, "core-task"),
    u(100, 200, 100, "noise"),
    u(200, 300, 100, "noise"),
    u(300, 400, 100, "noise"),
    u(400, 500, 100, "noise"),
    u(500, 600, 100, "noise"),
    u(600, 700, 100, "noise"),
    u(700, 800, 100, "noise"),
    u(800, 900, 100, "noise"),
    u(900, 1000, 100, "noise"),
    u(1000, 1100, 100, "core-task"),
  ];
  const opts = {
    preservePrefixTokens: 150,
    preserveTailTokens: 150,
    maxFoldTokens: 300,
  };
  const found = findCompressibleIndexRange(units, opts);
  check(
    "⑥ findCompressibleIndexRange 返回 7..9",
    found.ok === true && found.unitStart === 7 && found.unitEnd === 9,
    JSON.stringify(found),
  );
  check(
    "⑥ estimateShadowedTokens(7..9) = 300",
    estimateShadowedTokens(units, 7, 9) === 300,
    String(estimateShadowedTokens(units, 7, 9)),
  );
  check(
    "⑥ estimateCachePreservedTokens(7..9) = 700",
    estimateCachePreservedTokens(units, 7, 9) === 700,
    String(estimateCachePreservedTokens(units, 7, 9)),
  );
  const r = selectCompressRange(units, opts);
  check(
    "⑥ select 结果与 helper 估算一致",
    found.ok === true &&
      r.ok === true &&
      r.shadowedTokens === estimateShadowedTokens(units, found.unitStart, found.unitEnd) &&
      r.cachePreservedTokens ===
        estimateCachePreservedTokens(units, found.unitStart, found.unitEnd),
    JSON.stringify(r),
  );
}

// ---------- ⑦ 输入校验：结构化错误 ----------
{
  const cases = [
    {
      name: "units 不是数组",
      units: 42,
      opts: undefined,
      code: "invalid-units",
    },
    {
      name: "空 units",
      units: [],
      opts: undefined,
      code: "invalid-units",
    },
    {
      name: "unit 不是对象",
      units: [null],
      opts: undefined,
      code: "invalid-unit",
    },
    {
      name: "unit id 非 string",
      units: [u(0, 100, 10, "noise", 42)],
      opts: undefined,
      code: "invalid-unit-id",
    },
    {
      name: "unit id 全空白",
      units: [u(0, 100, 10, "noise", "   ")],
      opts: undefined,
      code: "invalid-unit-id",
    },
    {
      name: "负 token",
      units: [u(0, 100, -1, "noise")],
      opts: undefined,
      code: "negative-token",
    },
    {
      name: "非整数 token",
      units: [u(0, 100, 1.5, "noise")],
      opts: undefined,
      code: "invalid-token",
    },
    {
      name: "seqEnd < seqStart",
      units: [u(100, 0, 10, "noise")],
      opts: undefined,
      code: "invalid-seq",
    },
    {
      name: "非法 layer",
      units: [u(0, 100, 10, "bogus")],
      opts: undefined,
      code: "invalid-layer",
    },
    {
      name: "重复 seqStart",
      units: [
        u(0, 100, 10, "noise"),
        u(0, 200, 20, "detail"),
      ],
      opts: undefined,
      code: "duplicate-seq",
    },
    {
      name: "负 preservePrefixTokens",
      units: [u(0, 100, 10, "noise")],
      opts: { preservePrefixTokens: -1 },
      code: "invalid-prefix-budget",
    },
    {
      name: "maxFoldTokens <= 0",
      units: [u(0, 100, 10, "noise")],
      opts: { maxFoldTokens: 0 },
      code: "invalid-max-fold",
    },
    {
      name: "非法 protectedUnitIds",
      units: [u(0, 100, 10, "noise")],
      opts: { protectedUnitIds: [{}] },
      code: "invalid-protected-unit-id",
    },
  ];

  for (const item of cases) {
    const r = selectCompressRange(item.units, item.opts);
    check(
      `⑦ ${item.name} → ok:false code=${item.code}`,
      r.ok === false &&
        r.code === item.code &&
        typeof r.reason === "string",
      JSON.stringify(r),
    );
  }
}

console.log(
  `\nprobe-select-compress-range: ${passed}/${passed + failures} PASS${failures ? `, ${failures} FAIL` : ""}`,
);
process.exitCode = failures === 0 ? 0 : 1;
