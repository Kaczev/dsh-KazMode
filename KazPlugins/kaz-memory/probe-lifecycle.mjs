// 方向1 Stage1 小探针：验证 lifecycle 字段在真实引擎中的默认值/读取/更新。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { MemoryEngine } from "./lib/engine.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const root = mkdtempSync(join(tmpdir(), "kzm-lifecycle-"));
const proj = join(root, "proj");
const globalRoot = join(root, "home", "storages");

const ctx = new Context();
await ctx.plugin(Storage);
await ctx.plugin(MemoryEngine, { globalRoot, projectRoot: proj });
const memory = ctx.get("memory");

const saved = await memory.remember({
  name: "方向1 测试",
  keywords: ["方向1", "lifecycle"],
  summary: "验证结构化字段默认值",
  content: "新记忆带生命周期字段",
  namespace: "project",
  type: "success_pattern",
  evidence: "probe-lifecycle.mjs PASS",
  confidence: "high",
  projectRoot: proj,
});
check("新记忆默认 lifecycle_status=CANDIDATE", saved.lifecycle_status === "CANDIDATE");
check("新记忆 type/evidence/confidence 保留", saved.type === "success_pattern" && saved.evidence === "probe-lifecycle.mjs PASS" && saved.confidence === "high");
check("新记忆 usage_count=0", saved.usage_count === 0);
check("新记忆 last_used_at 缺省为 undefined", saved.last_used_at === undefined);

const table = memory.tableFor("global");
await table.put("legacy-lc", {
  namespace: "global",
  status: "applied",
  autoLoad: false,
  name: "Legacy lifecycle",
  content: "旧格式无方向1字段",
  keywords: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});
const legacy = await memory.get("legacy-lc");
check("旧记忆缺省 lifecycle_status=UNKNOWN", legacy.lifecycle_status === "UNKNOWN");
check("旧记忆缺省 type=unknown", legacy.type === "unknown");
check("旧记忆缺省 confidence=unknown", legacy.confidence === "unknown");
check("旧记忆缺省 usage_count=0", legacy.usage_count === 0);

const updated = await memory.update(saved.id, { type: "error_pattern", evidence: "updated evidence", confidence: "medium" });
check("update 可改 type/evidence/confidence", updated.type === "error_pattern" && updated.evidence === "updated evidence" && updated.confidence === "medium");
check("update 保留 lifecycle_status=CANDIDATE", updated.lifecycle_status === "CANDIDATE");

// search 默认排除 DEPRECATED（方向1）。
await table.put("dep-lc", {
  namespace: "global",
  status: "applied",
  autoLoad: false,
  name: "Legacy deprecated",
  summary: "",
  content: "deprecated test 内容",
  keywords: ["deprecated", "test"],
  lifecycle_status: "DEPRECATED",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});
const depRead = await memory.get("dep-lc");
check("DEPRECATED 记忆可读", depRead.lifecycle_status === "DEPRECATED");
const searchExcl = await memory.search("deprecated", { namespace: "global" });
check("search 默认排除 DEPRECATED", !searchExcl.some((h) => h.record.id === "dep-lc"));
const searchIncl = await memory.search("deprecated", { namespace: "global", includeDeprecated: true });
check("search includeDeprecated 包含 DEPRECATED", searchIncl.some((h) => h.record.id === "dep-lc"));

await engineDispose();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nLIFECYCLE PROBE OK" : `\nLIFECYCLE PROBE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

async function engineDispose() {
  // 简单清理：直接释放 ctx 的 effect（探针精简，退出进程前不严格 flush）。
  try {
    await memory?.closeAll?.();
  } catch { /* noop */ }
  try {
    await ctx?.dispose?.();
  } catch { /* noop */ }
}
