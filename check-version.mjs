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
//
// 2026-10-18（发 npm）：这个守卫多了三项「还发得出去吗」的检查——包名是 `dsh-kazmode`、
// 没有 `private: true`、`files` 里带着 `cordis.patch.yml` 与 `skills`。包名要和
// `kaz\cordis.patch.yml` 里那段 createRequire 表达式对得上，漏改一边技能会静默消失。

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

// 发布守卫：这个目录就是要发到 npm 的包，所以顺手确认它还发得出去。
// 包名被改掉、`private` 回来、`files` 少了补丁或技能，都会让使用者 `dsh plugin add dsh-kazmode`
// 拿不到能用的 bundle——现场的症状是「装上了但模式列表里没有它」，查起来比在这里拦下贵得多。
if (manifest !== undefined) {
  if (manifest.private === true) problems.push("kaz\\package.json is private: `npm publish` would refuse it");
  if (manifest.name !== "dsh-kazmode") {
    problems.push(`kaz\\package.json name is ${JSON.stringify(manifest.name)}, expected "dsh-kazmode" (the bundle patch mounts this package)`);
  }
  const files = manifest.files;
  const required = ["cordis.patch.yml", "skills", "index.js", "client.js", "prompt.md", "locale", "icon.svg"];
  if (!Array.isArray(files) || required.some((file) => !files.includes(file))) {
    problems.push(`kaz\\package.json files is ${JSON.stringify(files)}: the tarball must carry ${required.join(', ')}`);
  }
  if (manifest.dsh?.bundle?.patch?.length !== 1 || manifest.dsh.bundle.patch[0] !== "./cordis.patch.yml") {
    problems.push(`kaz\\package.json dsh.bundle.patch is ${JSON.stringify(manifest.dsh?.bundle?.patch)}`);
  }
}

for (const problem of problems) console.error(`FAIL ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
