// 方向1 Stage3 consolidate 脚本：计算 value、生成待淘汰清单（默认只报告，不改文件）。
// 用法：node consolidate.mjs [输出报告JSON路径]
// 默认输出到 DSH_HOME/storages/memory_consolidate_report.json。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DEFAULT_OPTIONS, computeValue, lifecycleAction, buildDeprecateCandidates } from "./lib/consolidate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_FILE = "C:/Users/Kaczev/Documents/GitHub/dsh-KazMode/.dsh/storages/memory_project.json";
const GLOBAL_FILE = "C:/Users/Kaczev/.dsh/storages/memory.json";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const DEFAULT_OUT = join(DSH_HOME, "storages", "memory_consolidate_report.json");

function loadRecords(file, namespace) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const data = JSON.parse(raw);
  const blocks = data?.tables?.blocks ?? {};
  return Object.entries(blocks).map(([id, blk]) => ({
    id,
    namespace,
    name: blk.name || "",
    summary: blk.summary || "",
    content: blk.content || "",
    keywords: Array.isArray(blk.keywords) ? blk.keywords : [],
    type: blk.type,
    evidence: blk.evidence,
    confidence: blk.confidence,
    usage_count: blk.usage_count,
    last_used_at: blk.last_used_at,
    lifecycle_status: blk.lifecycle_status,
    created_at: blk.created_at || blk.createdAt || "",
    updated_at: blk.updated_at || blk.updatedAt || "",
  }));
}

const project = loadRecords(PROJECT_FILE, "project");
const global = loadRecords(GLOBAL_FILE, "global");
const all = [...project, ...global];

const opts = { ...DEFAULT_OPTIONS };
const analyzed = all.map((rec) => {
  const value = computeValue(rec, opts);
  const action = lifecycleAction(rec, opts).action;
  return {
    id: rec.id,
    namespace: rec.namespace,
    name: rec.name,
    value,
    action,
    lifecycle_status: (rec.lifecycle_status || "UNKNOWN").toUpperCase(),
    usage_count: Number.isFinite(Number(rec.usage_count)) ? Number(rec.usage_count) : 0,
    last_used_at: rec.last_used_at || "",
    updated_at: rec.updated_at || "",
  };
});

const candidates = buildDeprecateCandidates(all, opts).map((c) => ({
  id: c.id,
  name: c.name,
  namespace: c.namespace,
  value: c.value,
  lifecycle_status: c.lifecycle_status,
  usage_count: c.usage_count,
  last_used_at: c.last_used_at,
  updated_at: c.updated_at,
  reason: c.reason,
  suggested_action: c.suggested_action,
}));

const rawArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const out = rawArgs[0] ?? DEFAULT_OUT;

const report = {
  generated_at: new Date().toISOString(),
  params: opts,
  counts: { project: project.length, global: global.length, all: all.length },
  candidate_count: candidates.length,
  candidates,
  analyzed,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log(`memory_count project=${project.length} global=${global.length} all=${all.length}`);
console.log(`candidate_count=${candidates.length}`);
console.log(`\n待淘汰清单（value 越低越优先）:`);
if (candidates.length === 0) {
  console.log("  无");
} else {
  for (const c of candidates) {
    console.log(
      `  ${c.value.toFixed(4)}  [${c.namespace}] ${c.name || c.id} | status=${c.lifecycle_status} usage=${c.usage_count} updated=${c.updated_at} | ${c.reason} | 建议=${c.suggested_action}`,
    );
  }
}
console.log(`\nreport -> ${out}`);

// ---- 可选写回（需 Kaczev 确认后才使用；默认不改任何文件） ----
// --mark-deprecated  : 对候选（建议 DEPRECATE）标记 lifecycle_status=DEPRECATED
// --archive          : 把候选快照到 $DSH_HOME/storages/memory_archive.json
// --forget           : 真正删除候选（只在 Kaczev 确认后使用）
if (flags.has("--mark-deprecated") || flags.has("--archive") || flags.has("--forget")) {
  const now = new Date().toISOString();
  const files = [
    { path: PROJECT_FILE, namespace: "project" },
    { path: GLOBAL_FILE, namespace: "global" },
  ];
  let changedFiles = 0;
  for (const file of files) {
    const data = JSON.parse(readFileSync(file.path, "utf8").replace(/^\uFEFF/, ""));
    const blocks = data?.tables?.blocks ?? {};
    let changed = false;
    for (const c of candidates) {
      if (c.namespace !== file.namespace) continue;
      const blk = blocks[c.id];
      if (!blk) continue;
      if (flags.has("--mark-deprecated") && c.suggested_action === "DEPRECATE") {
        blk.lifecycle_status = "DEPRECATED";
        blk.updated_at = now;
        changed = true;
        console.log(`[mark-deprecated] ${c.namespace}/${c.id} -> DEPRECATED`);
      }
      if (flags.has("--forget")) {
        if (blocks[c.id]) {
          delete blocks[c.id];
          changed = true;
          console.log(`[forget] ${c.namespace}/${c.id} 已删除`);
        }
      }
    }
    if (changed) {
      writeFileSync(file.path, JSON.stringify(data, null, 2) + "\n", "utf8");
      changedFiles += 1;
    }
  }
  if (flags.has("--archive")) {
    const archivePath = join(DSH_HOME, "storages", "memory_archive.json");
    let archive = [];
    if (existsSync(archivePath)) {
      try {
        const parsed = JSON.parse(readFileSync(archivePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(parsed)) archive = parsed;
        else if (Array.isArray(parsed?.archived)) archive = parsed.archived;
      } catch {
        archive = [];
      }
    }
    let added = 0;
    for (const c of candidates) {
      const existing = archive.find((entry) => entry.id === c.id);
      if (existing) continue;
      archive.push({ ...c, archived_at: now });
      added += 1;
    }
    if (added > 0) {
      mkdirSync(dirname(archivePath), { recursive: true });
      writeFileSync(archivePath, JSON.stringify({ archived: archive }, null, 2) + "\n", "utf8");
      console.log(`[archive] 已快照 ${added} 条到 ${archivePath}`);
    }
  }
  console.log(`[consolidate] changed_files=${changedFiles}`);
}
