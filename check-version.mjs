// check-version.mjs —— README 里那句"当前版本 X.Y.Z"必须与两个 VERSION 文件的**主版本**一致。
//
// 形状：VERSION 可以是 `X.Y.Z`，也可以是 `X.Y.Z-<后缀>`（后缀 = 发布/测试标记，
// 比如测试行领先一个 `8.9.8-b`）。后缀整体锚定：`8.9.8-bb-`、`8.9.8-`、`8.9.8.1` 都不合法。
// 比较的是主版本（`-` 之前那截），所以 README 的 `8.9.8` 与测试行的 `8.9.8-b` 算**相符**：
// 这个仓库在测试期的既定状态就是 README/`kaz` 在 `8.9.8`、`test-kaz` 领先一个 `-b`。
// 于是"两个 VERSION 必须逐字相同"**不是**这句话的要求，两个主版本都等于 README 才是。
//
// 为什么这个检查**不在预设行里**（`kaz\fork-param.regression.mjs` 那种位置）：
// 预设行是会**单独发出去**的东西——装机脚本把 `kaz\` 镜像到 `<home>\.agent-presets\kaz`，
// 那里没有仓库、没有 README、没有 `test-kaz\`。行内的套件按 `import.meta.url` 找自己的路径
// （所以它装到哪儿都能跑），一旦让它去读 `..\README.md`，就把"这个测试能不能跑"绑死在仓库布局上：
// 装机之后它要么找不到文件、要么得靠"文件不在就跳过"糊过去——而**跳过就是假绿**，
// 那比没有这个检查更坏（它看起来在守着，其实什么都没守）。
// 所以这个守卫住在仓库根、只属于仓库：它读的就是仓库里那三份文件的关系。
//
// 它还可以被单独的会话直接调用来当回归验证：`node check-version.mjs`；路径可用
// `--root <dir>` 覆盖（自测用，也方便以后从别处调用）。
//
// 修法是改 README 或改 VERSION，**不是**改这个脚本。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const ROOT = rootFlag >= 0 && args[rootFlag + 1] !== undefined ? resolve(args[rootFlag + 1]) : resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

const README = join(ROOT, "README.md");
const VERSIONS = [join(ROOT, "kaz", "VERSION"), join(ROOT, "test-kaz", "VERSION")];
const SHAPE = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.]+)?$/u;

const problems = [];
const notes = [];

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch (error) {
  console.error(`FAIL cannot read ${README}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// README 里出现**好几个**版本号形状的串（`0.1.5-rc.2` 是 dsh 运行时的要求），所以不能取"第一个"。
// 认的是那句话本身：`当前版本 X.Y.Z`。只取主版本——句子里不写后缀，那是 VERSION 文件自己的事。
// 句子改了/没了就当失败——那正是这个守卫存在的意义。
const sentence = /当前版本\s*(\d+\.\d+\.\d+)/u.exec(readme);
if (sentence === null) {
  problems.push(`README.md: no \`当前版本 X.Y.Z\` sentence found — the version line was reworded or removed, so this guard cannot see it`);
}

const readVersionFile = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    problems.push(`${path}: cannot read (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  const value = text.trim();
  const shape = SHAPE.exec(value);
  if (shape === null) {
    problems.push(`${path}: expected X.Y.Z or X.Y.Z-<suffix>, got ${JSON.stringify(value.slice(0, 40))}`);
    return null;
  }
  return { value, main: shape[1] };
};

const versions = VERSIONS.map(readVersionFile);
const [mainVersion, testVersion] = versions;

if (sentence !== null) {
  const stated = sentence[1];
  for (const [index, entry] of versions.entries()) {
    if (entry === null) continue;
    const which = index === 0 ? "kaz\\VERSION (the published row)" : "test-kaz\\VERSION (the test row)";
    if (entry.main !== stated) problems.push(`README.md says 当前版本 ${stated}, but ${which} says ${entry.value}`);
  }
  if (mainVersion !== null && testVersion !== null && mainVersion.value !== testVersion.value) {
    // 不单独判失败：上面"两个主版本都要等于 README"的那两条才是判据。
    notes.push(`kaz=${mainVersion.value} test-kaz=${testVersion.value} (differ)`);
  }
  if (problems.length === 0) {
    console.log(`OK README 当前版本 ${stated} == kaz\\VERSION ${mainVersion.value} == test-kaz\\VERSION ${testVersion.value}`);
  }
}

for (const note of notes) console.log(`note ${note}`);
for (const problem of problems) console.error(`FAIL ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
