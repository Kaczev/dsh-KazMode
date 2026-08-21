// kaz-memory 引擎集成探针：真实 cordis ctx + 真实 storage hub + 真实 MemoryEngine。
// 验证（不 mock 任何存储层）：
//   ① 项目记忆按项目根隔离：不同 projectRoot 各落各的 memory_project.json；
//   ② 全局记忆对任何项目根可见；
//   ③ search / setStatus / forget 跨项目域正确；
//   ④ 文件确实落在 <项目>/.dsh/storages/memory_project.json 与 <全局>/storages/memory.json。
// 运行：node kaz-memory/probe-engine.mjs
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

const root = mkdtempSync(join(tmpdir(), "kzm-engine-"));
const projA = join(root, "projA");
const projB = join(root, "projB");
const globalRoot = join(root, "home", "storages");

const ctx = new Context();
const storageFiber = await ctx.plugin(Storage);
const engineFiber = await ctx.plugin(MemoryEngine, { globalRoot, projectRoot: projA });
const memory = ctx.get("memory");
check("memory 服务已注册", memory !== undefined);

const a = await memory.remember({ content: "项目 A 的记忆", namespace: "project", projectRoot: projA });
check("项目 A 保存成功", a.namespace === "project" && a.projectRoot === projA);
const b = await memory.remember({ content: "项目 B 的记忆", namespace: "project", projectRoot: projB });
check("项目 B 保存成功", b.namespace === "project" && b.projectRoot === projB);
const g = await memory.remember({ content: "全局记忆", namespace: "global" });
check("全局保存成功", g.namespace === "global");

const listA = await memory.list({ projectRoot: projA });
const listB = await memory.list({ projectRoot: projB });
check("项目 A 只看到自己的项目记忆", listA.some((r) => r.id === a.id) && !listA.some((r) => r.id === b.id));
check("项目 B 只看到自己的项目记忆", listB.some((r) => r.id === b.id) && !listB.some((r) => r.id === a.id));
check("全局记忆两边都可见", listA.some((r) => r.id === g.id) && listB.some((r) => r.id === g.id));

const hitA = await memory.search("项目 A", { projectRoot: projA });
const hitB = await memory.search("项目 A", { projectRoot: projB });
check("search 项目隔离", hitA.some((h) => h.record.id === a.id) && !hitB.some((h) => h.record.id === a.id));

await memory.setStatus(b.id, "auto");
const listB2 = await memory.list({ projectRoot: projB });
check("setStatus 生效（auto 归一化为 applied）", listB2.find((r) => r.id === b.id).status === "applied");
check("forget A 的项目记忆", (await memory.forget(a.id)) === true);
check("forget 后 A 不再有该记忆", !(await memory.list({ projectRoot: projA })).some((r) => r.id === a.id));

const fileA = join(projA, ".dsh", "storages", "memory_project.json");
const fileB = join(projB, ".dsh", "storages", "memory_project.json");
const fileG = join(globalRoot, "memory.json");
check("项目 A 记忆文件落在项目文件夹", existsSync(fileA));
check("项目 B 记忆文件落在项目文件夹", existsSync(fileB));
check("全局记忆文件落在全局 storages", existsSync(fileG));

// JsonStorageBackend 的落盘是异步 flush 的，先让事件循环转一下再读文件。
await new Promise((resolve) => setTimeout(resolve, 100));

// 新格式落盘：ISO 字符串时间戳、无旧数字键、含 summary（2026-08 升级）
// 注意：记录 a 已在上文 forget，用仍在库里的项目记录 b 校验文件格式。
const rawB = JSON.parse(readFileSync(fileB, "utf8"));
const blockB = rawB.tables.blocks[b.id];
check("新格式：写盘含 created_at/updated_at（ISO 字符串，updated ≥ created）", typeof blockB.created_at === "string" && typeof blockB.updated_at === "string" && blockB.updated_at >= blockB.created_at && Number.isFinite(Date.parse(blockB.created_at)));
check("新格式：不再写旧数字时间戳", !("createdAt" in blockB) && !("updatedAt" in blockB));
check("新格式：summary 字段存在（未提供时为空串）", typeof blockB.summary === "string" && blockB.summary === "");

// 旧格式兼容：数字时间戳读取时迁移为 ISO；缺失 summary 回退空串
const table = memory.tableFor("global");
await table.put("legacy-1", {
  namespace: "global",
  status: "applied",
  autoLoad: false,
  name: "Legacy",
  content: "旧格式记录",
  keywords: [],
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
});
const legacy = await memory.get("legacy-1");
check("旧格式记录读取时迁移为 ISO 时间戳", typeof legacy.created_at === "string" && legacy.created_at.startsWith("2023-") && typeof legacy.updated_at === "string" && legacy.updated_at.startsWith("2023-"));
check("旧格式记录 summary 回退空串", legacy.summary === "");

// 只读不建目录（Kaczev 2026-08-17 的 bug：JsonStorageBackend 一打开域就 mkdir，
// 之前镜像读操作会在没有真实项目根时去桌面建出空的 .dsh/storages）。
const projC = join(root, "projC");
check("新项目根只读前不存在目录", !existsSync(join(projC, ".dsh", "storages")));
const listC = await memory.list({ namespace: "project", projectRoot: projC });
check("新项目根只读返回空（project 过滤）", Array.isArray(listC) && listC.length === 0);
check("新项目根只读后目录仍不存在（不因读而建目录）", !existsSync(join(projC, ".dsh", "storages")));
const listAllC = await memory.list({ projectRoot: projC });
check("默认 list 不含 projC 的记忆", !listAllC.some((r) => r.projectRoot === projC));
check("默认 list 后目录仍不存在", !existsSync(join(projC, ".dsh", "storages")));
const searchC = await memory.search("anything", { namespace: "project", projectRoot: projC });
check("新项目根只读 search 也返回空", Array.isArray(searchC) && searchC.length === 0);
check("新项目根只读 search 后目录仍不存在", !existsSync(join(projC, ".dsh", "storages")));
// 写入才创建目录与文件
const c = await memory.remember({ content: "写入才建目录", namespace: "project", projectRoot: projC });
check("写入后才创建项目记忆文件", existsSync(join(projC, ".dsh", "storages", "memory_project.json")));
check("写入后的记忆可读回", (await memory.list({ projectRoot: projC })).some((r) => r.id === c.id));

await engineFiber.dispose();
await storageFiber.dispose();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nENGINE PROBE OK" : `\nENGINE PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
