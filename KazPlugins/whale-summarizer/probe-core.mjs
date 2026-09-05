#!/usr/bin/env node
// probe-core.mjs —— offline pure-function probe for whale-summarizer.
// No network, no Cordis, no LLM.

import {
  DEFAULT_OPTIONS,
  ERROR_CODES,
  WhaleSummarizerError,
  assembleSummaryText,
  buildPrompt,
  finishErrorOf,
  sourceIdsOf,
  validateSummarizeInput,
} from "./lib/core.mjs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validInput(overrides = {}) {
  return {
    evidence: [
      { kind: "leaf", id: "leaf-1", text: "original raw text A", path: "r/leaf-1" },
      { kind: "block", id: "block-2", text: "prior block summary B", path: "r/block-2" },
    ],
    refs: [
      { kind: "leaf", id: "leaf-1", path: "r/leaf-1", seq: 11 },
      { kind: "block", id: "block-2", path: "r/block-2" },
    ],
    purpose: "close-round",
    ...overrides,
  };
}

check("validateSummarizeInput accepts valid direct-children input", () => {
  const result = validateSummarizeInput(validInput());
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  if (result.input.evidence.length !== 2) throw new Error("evidence length");
  if (result.input.refs.length !== 2) throw new Error("refs length");
  if (result.input.purpose !== "close-round") throw new Error("purpose");
  if (result.input.opts.maxAttempts !== DEFAULT_OPTIONS.maxAttempts) throw new Error("defaults");
});

check("validateSummarizeInput rejects missing evidence/refs", () => {
  const r1 = validateSummarizeInput({ evidence: [], refs: [], purpose: "promote" });
  if (r1.ok || r1.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("empty accepted");
  const r2 = validateSummarizeInput({ refs: [], purpose: "promote" });
  if (r2.ok || r2.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("missing evidence accepted");
});

check("validateSummarizeInput rejects non-direct-children extra top-level key", () => {
  const result = validateSummarizeInput({ ...validInput(), history: [] });
  if (result.ok || result.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("history accepted");
});

check("validateSummarizeInput rejects nested evidence children field", () => {
  const input = validInput({
    evidence: [
      { kind: "block", id: "block-1", text: "s", children: [{ kind: "leaf", id: "leaf-x", text: "expanded" }] },
    ],
    refs: [{ kind: "block", id: "block-1" }],
  });
  const result = validateSummarizeInput(input);
  if (result.ok || !String(result.error?.message).includes("unsupported key")) {
    throw new Error(JSON.stringify(result));
  }
});

check("validateSummarizeInput rejects unknown purpose", () => {
  const result = validateSummarizeInput(validInput({ purpose: "compact" }));
  if (result.ok || result.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("bad purpose accepted");
});

check("validateSummarizeInput rejects refs/evidence mismatch", () => {
  const result = validateSummarizeInput(validInput({ refs: [{ kind: "block", id: "block-2" }] }));
  if (result.ok || result.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("mismatch accepted");
});

check("validateSummarizeInput rejects duplicate ref ids", () => {
  const input = {
    evidence: [
      { kind: "leaf", id: "same", text: "a" },
      { kind: "leaf", id: "same", text: "b" },
    ],
    refs: [
      { kind: "leaf", id: "same", seq: 1 },
      { kind: "leaf", id: "same", seq: 2 },
    ],
    purpose: "close-round",
  };
  const result = validateSummarizeInput(input);
  if (result.ok || result.error.code !== ERROR_CODES.INVALID_INPUT) throw new Error("duplicate accepted");
});

check("sourceIdsOf returns unique evidence order", () => {
  const valid = validateSummarizeInput(validInput());
  const ids = sourceIdsOf(valid.input);
  if (JSON.stringify(ids) !== JSON.stringify(["leaf-1", "block-2"])) throw new Error(`ids=${JSON.stringify(ids)}`);
});

check("buildPrompt includes purpose, ids, leaf/block text, no system/tools", () => {
  const valid = validateSummarizeInput(validInput());
  const prompt = buildPrompt(valid.input);
  for (const needle of ["close-round", "leaf-1", "block-2", "original raw text A", "prior block summary B"]) {
    if (!prompt.includes(needle)) throw new Error(`prompt missing ${needle}`);
  }
  if (/\bsystem\s*:/i.test(prompt)) throw new Error("prompt contains system");
  if (/\btools?\s*:/i.test(prompt)) throw new Error("prompt contains tools");
});

check("assembleSummaryText accepts text blocks and bounds chars", () => {
  const ok = assembleSummaryText([{ type: "text", text: " hello " }], 100);
  if (!ok.ok || ok.summary !== "hello") throw new Error(JSON.stringify(ok));
  const capped = assembleSummaryText([{ type: "text", text: "abcdef" }], 3);
  if (!capped.ok || capped.summary !== "abc") throw new Error(JSON.stringify(capped));
});

check("assembleSummaryText rejects reasoning/tool/empty output", () => {
  if (assembleSummaryText([{ type: "reasoning", text: "x" }], 100).ok) throw new Error("reasoning accepted");
  if (assembleSummaryText([{ type: "tool-call", id: "c", name: "x", arguments: "{}" }], 100).ok) throw new Error("tool accepted");
  if (assembleSummaryText([{ type: "text", text: "  " }], 100).ok) throw new Error("empty accepted");
});

check("finishErrorOf maps stop to null and error to failure", () => {
  if (finishErrorOf({ kind: "stop" }) !== null) throw new Error("stop not null");
  const error = finishErrorOf({ kind: "error", failure: { message: "boom", code: "NETWORK" } });
  if (!(error instanceof WhaleSummarizerError) || error.code !== ERROR_CODES.SUMMARY_FAILED) {
    throw new Error("error finish not mapped");
  }
});

if (failed > 0) {
  console.error(`probe-core.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-core.mjs ALL PASS (${passed})`);
}
