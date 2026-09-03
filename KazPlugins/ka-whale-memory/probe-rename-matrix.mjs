// ka-whale-memory 改名矩阵探针（验收 3）：
//   - 包名/插件 id/命名空间/RPC 通道均为 ka-whale-memory；
//   - memory.json / memory_project.json 路径常量保持不变；
//   - 旧键 kaz-memory 兼容读由 kaz-shared 归一化（另由 kaz-mode probe 验证）。
// 运行：node KazPlugins/ka-whale-memory/probe-rename-matrix.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { name as pluginName } from "./lib/index.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

const repoRoot = process.cwd();
const pkg = JSON.parse(readFileSync(join(repoRoot, "KazPlugins", "ka-whale-memory", "package.json"), "utf8"));
check("包名 = ka-whale-memory", pkg.name === "ka-whale-memory");
check("插件导出 name = ka-whale-memory", pluginName === "ka-whale-memory");

const libIndex = readFileSync(join(repoRoot, "KazPlugins", "ka-whale-memory", "lib", "index.js"), "utf8");
check("settings 命名空间/RPC 使用 ka-whale-memory", libIndex.includes('settingsNamespace("ka-whale-memory")') && libIndex.includes('"/ka-whale-memory"'));
check("source.plugin 标识 = ka-whale-memory", libIndex.includes('plugin: "ka-whale-memory"'));

const libEngine = readFileSync(join(repoRoot, "KazPlugins", "ka-whale-memory", "lib", "engine.js"), "utf8");
check("engine 保留 memory.json / memory_project.json 文件名", /memory\.json/.test(libEngine) && /memory_project\.json/.test(libEngine));

// 代码文件无旧组件名残留（LICENSE 属历史版权说明，不参与）。
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
};
const codeFiles = walk(join(repoRoot, "KazPlugins", "ka-whale-memory")).filter(
  (p) => !p.replace(/\\/g, "/").endsWith("probe-rename-matrix.mjs"),
);
const oldRefs = codeFiles.filter((p) => readFileSync(p, "utf8").includes("kaz-memory"));
check("ka-whale-memory 代码文件无 kaz-memory 残留", oldRefs.length === 0);

console.log(failures === 0 ? "\nKA-WHALE-MEMORY RENAME MATRIX PROBE OK" : `\nKA-WHALE-MEMORY RENAME MATRIX PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
