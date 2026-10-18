// check-version.mjs —— README 里那句"当前版本 X.Y.Z"必须与 `kaz\package.json` 的**主版本**一致。
//
// 形状：package.json 的 version 可以是 `X.Y.Z`，也可以是 `X.Y.Z-<后缀>`（后缀 = 发布标记）。
// 后缀整体锚定：`8.9.8-dd-`、`8.9.8-`、`8.9.8.1` 都不合法。比较的是主版本（`-` 之前那截），
// 所以 README 的 `9.0.0` 与 package.json 的 `9.0.0-rc.1` 算**相符**：README 那句话只写主版本。
//
// 为什么这个检查**不在预设里**：它读的是**仓库**里的两份文件——README 那句版本话，和
// kaz\package.json。预设装到哪台机器上都一样，而"仓库说的版本 == 打包出去的版本"是仓库自己
// 的事。换一个没有 README 的地方它要么找不到文件、要么得靠"文件不在就跳过"糊过去——而
// **跳过就是假绿**，那比没有这个检查更坏。
//
// 它还可以被单独的会话直接调用来当回归验证：`node check-version.mjs`；路径可用
// `--root <dir>` 覆盖（自测用，也方便以后从别处调用）。
//
// 修法是改 README 或改 kaz\package.json 的 version，**不是**改这个脚本。
//
// 2026-10-18（v9）：仓库换代成"纯 YAML 预设 + 一个技能"后，`kaz\VERSION` 与生成器一起删了，
// 版本号的唯一出处收窄成 `kaz\package.json`；本守卫的判据仍是"仓库说的 == 打包的"，只是右边
// 换了文件。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const ROOT =
  rootFlag >= 0 && args[rootFlag + 1] !== undefined
    ? resolve(args[rootFlag + 1])
    : resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

const README = join(ROOT, "README.md");
const MANIFEST = join(ROOT, "kaz", "package.json");
const SHAPE = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.]+)?$/u;

const problems = [];

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch (error) {
  console.error(`FAIL cannot read ${README}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// README 里出现好几种版本号形状的串（举例里的 `0.2.1-rc.2`），所以不能取"第一个"。
// 认的是那句话本身：`当前版本 X.Y.Z`。只取主版本——句子里不写后缀。
const sentence = /当前版本\s*(\d+\.\d+\.\d+)/u.exec(readme);
if (sentence === null) {
  problems.push("README.md: no `当前版本 X.Y.Z` sentence found — the version line was reworded or removed, so this guard cannot see it");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (error) {
  problems.push(`${MANIFEST}: cannot read or parse (${error instanceof Error ? error.message : String(error)})`);
}

let published;
if (manifest !== undefined) {
  const value = manifest.version;
  if (typeof value !== "string") {
    problems.push(`${MANIFEST}: no string \`version\` field`);
  } else {
    const shape = SHAPE.exec(value);
    if (shape === null) problems.push(`${MANIFEST}: expected X.Y.Z or X.Y.Z-<suffix>, got ${JSON.stringify(value.slice(0, 40))}`);
    else published = { value, main: shape[1] };
  }
}

if (sentence !== null && published !== undefined) {
  const stated = sentence[1];
  if (published.main !== stated) {
    problems.push(`README.md says 当前版本 ${stated}, but kaz\\package.json says ${published.value}`);
  }
  if (problems.length === 0) console.log(`OK README 当前版本 ${stated} == kaz\\package.json ${published.value}`);
}

for (const problem of problems) console.error(`FAIL ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
