// make-bundle-patch.mjs —— 从 kaz 的**单一事实源**生成 profile bundle 需要的两个文件。
//
// 生成物（都在 `kaz\` 里，都**不入库**）：
//   kaz\package.json      版本号取自 kaz\VERSION，声明 dsh.bundle.patch
//   kaz\cordis.patch.yml  一行 insert：把预设声明成 `preset-kaz`
//
// 它取代了 `install-kaz-preset.ps1` 里那段"生成补丁 + 装机"的逻辑（那个脚本是网页端/CLI 线
// 的工具，版本闸门钉在 0.1.7-rc.2，在桌面端跑不了）。**现在不再把预设拷进 `<home>\.agent-presets\`**
// ——那是 0.1.7 之前的交付方式；桌面端用 profile bundle 交付，仓库目录本身就是活体。
//
// 为什么要生成而不是手写：这个补丁层的 `plugins:` 是 `kaz\agent.cordis.yml` 的**逐行副本**
// （预设声明里的 plugins 必须是行内条目，没有"引用外部文件"这回事）。手抄一次就多一份会走形的
// 副本；生成器让它每次都可复现。
//
// 与事实源**故意不同**的一处改写，写死在下面的 RENAMES 里：
//   每个相对 name（`./kaz-system-prompt.mjs`、`./functions/.../lib/index.js`）换成**绝对 file URL**，
//   锚点是**本仓库的** `kaz\` 目录（不再是某个 home 的 `.agent-presets\kaz\`）。
//   相对 name 的锚点在两处不一致：离线组合（`--dump-config`）按补丁文件所在目录锚定，
//   而真实挂载时按**进程工作目录**解析——绝对地址在两种路径下都是同一个地址。
//
// `skill-visibility` 那行的 `customSkillDirs` 保留 `!!js ... new URL('skills/', baseUrl)` 不动：
// `baseUrl` 是**本补丁文件所在目录**，也就是 `kaz\`，所以它指的是 `kaz\skills\`。
//
// 跑法（桌面端没有独立的 node.exe，用它自己的运行时；也可以直接用一个 Node 24）：
//   $env:ELECTRON_RUN_AS_NODE=1; & "<安装目录>\DeepSeek Harness.exe" <本文件绝对路径>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(REPO, "kaz");
const SOURCE = join(PRESET_DIR, "agent.cordis.yml");
const PRESET_YML = join(PRESET_DIR, "preset.yml");
const VERSION_FILE = join(PRESET_DIR, "VERSION");
const OUT_PACKAGE = join(PRESET_DIR, "package.json");
const OUT_PATCH = join(PRESET_DIR, "cordis.patch.yml");

/** 预设声明里的 id / 排序。id 是预设自己的标识（模式选择器按它认人）； */
/** `kaz\preset.yml` 没有 order 字段，5 沿用 install-kaz-preset.ps1 生成物里的值。 */
const PRESET_ID = "kaz";
const PRESET_ORDER = 5;

/** 补丁层里 `plugins:` 与它下面的条目共用的缩进（与官方预设的写法一致）。 */
const INDENT = "        ";

/** 相对 name -> 绝对 file URL。锚点是**本仓库的** kaz 目录。 */
const RENAMES = [
  {
    match: /^(\s*)name: \.\/kaz-system-prompt\.mjs\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "kaz-system-prompt.mjs")).href}`,
  },
  {
    match: /^(\s*)name: \.\/functions\/kaz-shared\/lib\/index\.js\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "functions/kaz-shared/lib/index.js")).href}`,
  },
  {
    match: /^(\s*)name: \.\/functions\/ka-whale-memory\/lib\/index\.js\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "functions/ka-whale-memory/lib/index.js")).href}`,
  },
  {
    match: /^(\s*)name: \.\/functions\/ka-whale-workflow\/lib\/index\.js\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "functions/ka-whale-workflow/lib/index.js")).href}`,
  },
  {
    match: /^(\s*)name: \.\/functions\/skill-visibility\/lib\/index\.js\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "functions/skill-visibility/lib/index.js")).href}`,
  },
  {
    match: /^(\s*)name: \.\/functions\/kaz-context-policy\/lib\/index\.js\s*$/u,
    to: (indent) => `${indent}name: ${pathToFileURL(join(PRESET_DIR, "functions/kaz-context-policy/lib/index.js")).href}`,
  },
];

/** 包名/行 id 的改名：Kaz 这份目前一个都不需要（每个 row 的名字都在 0.2.0-rc.2 的包表里核过）。 */
const PACKAGE_RENAMES = [];

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

const readText = (path) => {
  if (!existsSync(path)) fail(`missing ${path}`);
  return readFileSync(path, "utf8");
};

// ── 事实源读取 ──────────────────────────────────────────────────────────────

const presetText = readText(PRESET_YML);
const field = (key) => {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(presetText);
  if (match === null) fail(`preset.yml: no \`${key}:\` line`);
  return match[1].trim();
};
const presetName = field("name");
const presetDescription = field("description");

const version = readText(VERSION_FILE).trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(version)) fail(`VERSION: unexpected shape ${JSON.stringify(version)}`);

// ── 逐行变换 ────────────────────────────────────────────────────────────────

const allLines = readText(SOURCE).split(/\r?\n/u);
const firstRow = allLines.findIndex((line) => /^- id:/u.test(line));
if (firstRow < 0) fail(`${SOURCE}: no top-level \`- id:\` row found`);

const rawRows = allLines.slice(firstRow);
while (rawRows.length > 0 && rawRows[rawRows.length - 1].trim() === "") rawRows.pop();
if (rawRows.some((line) => line.length > 0 && !/^\s/u.test(line) && !/^- id:/u.test(line) && !/^#/u.test(line))) {
  fail(`${SOURCE}: a non-indented, non-comment line appeared after the first row — the file is not a flat row list`);
}

const rows = rawRows.map((line) => (line.length === 0 ? "" : INDENT + line));

const counts = { renames: 0, packageRenames: 0 };
const rewrote = [];
for (const [index, line] of rows.entries()) {
  for (const rename of RENAMES) {
    const match = rename.match.exec(line);
    if (match === null) continue;
    const next = rename.to(match[1]);
    rewrote.push(next.trim());
    rows[index] = next;
    counts.renames += 1;
  }
}
for (const rename of PACKAGE_RENAMES) {
  const idPattern = new RegExp(`^(\\s*)- id: ${rename.idFrom}\\s*$`, "u");
  const namePattern = new RegExp(`^(\\s*)name: '${rename.nameFrom.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'\\s*$`, "u");
  let sawId = false;
  let sawName = false;
  for (const [index, line] of rows.entries()) {
    const idMatch = idPattern.exec(line);
    if (idMatch !== null) {
      rows[index] = `${idMatch[1]}- id: ${rename.idTo}`;
      sawId = true;
      continue;
    }
    const nameMatch = namePattern.exec(line);
    if (nameMatch !== null) {
      rows[index] = `${nameMatch[1]}name: '${rename.nameTo}'`;
      sawName = true;
    }
  }
  if (!sawId || !sawName) fail(`${SOURCE}: expected both \`id: ${rename.idFrom}\` and \`name: '${rename.nameFrom}'\` (${rename.why})`);
  counts.packageRenames += 1;
}

// 每个相对 name 都必须被 RENAMES 覆盖：漏一个就报错，逼人来看。
const relative = rows.filter((line) => /^\s*name: \.\//u.test(line));
if (relative.length > 0) fail(`${SOURCE}: ${relative.length} relative \`name:\` row(s) left; add them to RENAMES — ${relative[0].trim()}`);
if (counts.renames !== RENAMES.length) fail(`expected ${RENAMES.length} path rewrites, made ${counts.renames} — RENAMES no longer matches the source`);
// 旧包名一个都不许留下（只看真正的行，不看注释：事实源里会解释这些改名）。
const codeRows = rows.filter((line) => !/^\s*#/u.test(line));
const knownGone = ["@deepseek-ai/dsh-workflow-worker-thread", "@deepseek-ai/dsh-agent-presets", "@deepseek-ai/dsh-tool-plugin-manager"];
for (const gone of knownGone) {
  if (codeRows.some((line) => line.includes(gone))) fail(`${SOURCE}: still references ${gone}; check it against the desktop 0.2.0-rc.2 package table`);
}

// ── 写出 ────────────────────────────────────────────────────────────────────

const header = [
  "# Generated by make-bundle-patch.mjs -- do not edit by hand; re-run the generator.",
  "#",
  "# kaz 的 profile bundle 补丁层。它只做一件事：把预设声明成 `preset-kaz`，让它在桌面端",
  "# （dsh 0.2.0-rc.2）的模式选择器里出现。",
  "#",
  "# `plugins:` 是 `kaz\\agent.cordis.yml` 的逐行副本（预设声明里的 plugins 必须是行内条目，",
  "# 没有引用外部文件这回事）。事实源仍然是那个文件；这一份是它的生成物。",
  "#",
  "# 与事实源故意不同的一处（生成器里的 RENAMES 是它的唯一出处）：",
  "#   每个相对 name -> **绝对 file URL**，锚点是本仓库的 kaz\\ 目录。",
  "#   相对 name 的锚点在 `--dump-config` 的离线组合（按补丁文件所在目录）与真实挂载",
  "#   （按进程 CWD）两处不一致；绝对地址在两种路径下都是同一个地址。",
  "#",
  "# 这一份取代了 install-kaz-preset.ps1 生成的那份：那一份的绝对 URL 指向",
  "# `<home>\\.agent-presets\\kaz\\`（0.1.7 之前的交付方式）。桌面端交付后，仓库目录本身就是活体，",
  "# 不再有 `.agent-presets` 这一站。",
  "#",
  "# 注意 `skill-visibility` 那行的 customSkillDirs 用的是 `!!js ... new URL('skills/', baseUrl)`：",
  "# `baseUrl` 是**本补丁文件所在目录**，也就是 kaz\\，所以它指的是 kaz\\skills\\。",
  "- insert:",
  "    - id: preset-kaz",
  "      name: '@deepseek-ai/dsh-agent-preset'",
  "      config:",
  `        id: ${PRESET_ID}`,
  `        name: '${presetName.replace(/'/gu, "''")}'`,
  `        description: '${presetDescription.replace(/'/gu, "''")}'`,
  `        order: ${PRESET_ORDER}`,
  "        plugins:",
];

writeFileSync(OUT_PATCH, `${[...header, ...rows].join("\n")}\n`);

const pkg = {
  name: "kaz-preset-bundle",
  version,
  private: true,
  dsh: { bundle: { patch: ["./cordis.patch.yml"] } },
};
writeFileSync(OUT_PACKAGE, `${JSON.stringify(pkg, null, 4)}\n`);

console.log(`wrote ${OUT_PACKAGE} (version ${version})`);
console.log(`wrote ${OUT_PATCH} (${rows.length} plugin lines, ${counts.renames} path rewrite(s), ${counts.packageRenames} package rename(s))`);
for (const line of rewrote) console.log(`  rewrote ${line}`);
