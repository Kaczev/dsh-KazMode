// 方向1 Stage4 召回探针：验证新记忆可召回、结构化字段不进 BM25、DEPRECATED 默认不召回。
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

const root = mkdtempSync(join(tmpdir(), "kzm-stage4-"));
const proj = join(root, "proj");
const globalRoot = join(root, "home", "storages");

const ctx = new Context();
await ctx.plugin(Storage);
await ctx.plugin(MemoryEngine, { globalRoot, projectRoot: proj });
const memory = ctx.get("memory");

// 新记忆带结构化字段：type/evidence/confidence 都不应进 BM25 文档。
const newRec = await memory.remember({
  name: "新记忆可召回",
  summary: "new memory recall test",
  content: "piano melody rhythm",
  keywords: ["piano", "music"],
  namespace: "global",
  type: "insight",
  evidence: "specific-evidence-token-xyz",
  confidence: "high",
});
check("新记忆可读取且默认 CANDIDATE", (await memory.get(newRec.id)).lifecycle_status === "CANDIDATE");
const hitNew = await memory.search("piano melody");
check("新记忆可被召回", hitNew.some((h) => h.record.id === newRec.id && h.score > 0));
const hitEvidence = await memory.search("specific-evidence-token-xyz");
check("结构化字段 evidence 不进 BM25（不因此命中）", !hitEvidence.some((h) => h.record.id === newRec.id));

// DEPRECATED 记忆默认不召回，显式 include 才召回。
const depRec = await memory.remember({
  name: "deprecated 不召回",
  summary: "deprecated recall test",
  content: "carrot drum",
  keywords: ["carrot"],
  namespace: "global",
});
await memory.update(depRec.id, { lifecycle_status: "DEPRECATED" });
const hitDep = await memory.search("carrot");
check("DEPRECATED 记忆默认不召回", !hitDep.some((h) => h.record.id === depRec.id));
const hitDepIncl = await memory.search("carrot", { includeDeprecated: true });
check("includeDeprecated=true 时才召回 DEPRECATED", hitDepIncl.some((h) => h.record.id === depRec.id));

// 噪音下降：多条 DEPRECATED 噪音记忆在默认 search 中不出现。
for (let i = 1; i <= 3; i += 1) {
  await memory.remember({
    name: `noise deprecated ${i}`,
    summary: "noise",
    content: `noise carrot drum ${i}`,
    keywords: ["carrot"],
    namespace: "global",
    lifecycle_status: "DEPRECATED",
  });
}
const noiseDefault = await memory.search("carrot");
const noiseIncl = await memory.search("carrot", { includeDeprecated: true });
check("DEPRECATED 噪音默认被过滤（噪音下降）", noiseDefault.length < noiseIncl.length && !noiseDefault.some((h) => String(h.record.content).startsWith("noise carrot")));

await memory.closeAll?.();
await ctx?.dispose?.();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nSTAGE4 PROBE OK" : `\nSTAGE4 PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
