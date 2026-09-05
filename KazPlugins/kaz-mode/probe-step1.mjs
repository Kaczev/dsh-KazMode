// kaz-mode Step1 面板/残留探针（静态源码断言）。
// 覆盖验收 4/5：Kaz 面板只显示 4 个组件 + 外置工具添加通道；
// first-round-hints / thinking-anchor 在 KazPlugins/kaz 代码中无残留。
// 运行：node KazPlugins/kaz-mode/probe-step1.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// 本文件可能经 repo junction 解析到 profile 副本，因此 repo 根取 process.cwd()（探针在 repo 根运行）。
const repoRoot = process.cwd();
const ownPath = fileURLToPath(import.meta.url);
const clientPath = join(here, "lib", "client.js");
const clientSrc = readFileSync(clientPath, "utf8");

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// Kaz 5.0 面板保留：output-beep / deepseek-default-model / round-display（受管）
// + kaz-agent-preset-display（常驻补丁） = 4 个组件。
check(
  "客户端 KAZ_PANEL_COMPONENT_IDS 只含 3 个受管组件",
  /const KAZ_PANEL_COMPONENT_IDS = Object\.freeze\(\["output-beep", "deepseek-default-model", "round-display"\]\);/.test(clientSrc),
);
check(
  "客户端 PATCH_PLUGINS 常驻显示 kaz-agent-preset-display",
  /id: "kaz-agent-preset-display"/.test(clientSrc) && /const PATCH_PLUGINS/.test(clientSrc),
);
check(
  "面板组件合计 4（3 受管 + 1 补丁）且无 ka-whale-memory / ka-whale-workflow / create-plan 面板行",
  clientSrc.includes("const PLUGINS = ALL_PLUGINS.filter") &&
    clientSrc.includes("KAZ_PANEL_COMPONENT_IDS.includes(plugin.id)") &&
    !/const PLUGINS = \[\s*\{\s*id: "ka-whale-memory"/.test(clientSrc),
);
check(
  "B4/6.0.3 候选查看通道保留（私有只读 + 外置插件/工具可添加）",
  clientSrc.includes("＋ 添加外置插件") &&
    clientSrc.includes("＋ 添加工具") &&
    clientSrc.includes("添加私有插件候选") === false &&
    clientSrc.includes("私有插件候选") &&
    clientSrc.includes("tool-jobs"),
);

// 已删除组件在 KazPlugins/kaz 代码/配置中无残留引用（排除本探针自身）。
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|yml|json)$/.test(entry.name)) out.push(p);
  }
  return out;
};
const files = [
  ...walk(join(repoRoot, "KazPlugins")),
  ...walk(join(repoRoot, "kaz")),
].filter((p) => !p.replace(/\\/g, "/").endsWith("probe-step1.mjs"));
for (const name of ["first-round-hints", "thinking-anchor"]) {
  const leaked = files.filter((p) => readFileSync(p, "utf8").includes(name));
  check(`代码/配置无 ${name} 残留`, leaked.length === 0);
}

console.log(failures === 0 ? "\nKAZ-MODE STEP1 PROBE OK" : `\nKAZ-MODE STEP1 PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
