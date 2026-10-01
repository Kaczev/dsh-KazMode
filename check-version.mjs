// check-version.mjs —— README 里那句"当前版本 X.Y.Z"必须与 kaz\VERSION 的**主版本**一致。
//
// 形状：VERSION 可以是 `X.Y.Z`，也可以是 `X.Y.Z-<后缀>`（后缀 = 发布标记，比如 `8.9.8-d`）。
// 后缀整体锚定：`8.9.8-dd-`、`8.9.8-`、`8.9.8.1` 都不合法。
// 比较的是主版本（`-` 之前那截），所以 README 的 `8.9.8` 与 `kaz\VERSION` 的 `8.9.8-d`
// 算**相符**：README 那句话只写主版本，后缀是 VERSION 文件自己的事。
//
// 为什么这个检查**不在预设行里**（`kaz\fork-param.regression.mjs` 那种位置）：
// 预设行是会**单独发出去**的东西——装机脚本把 `kaz\` 镜像到 `<home>\.agent-presets\kaz`，
// 那里没有仓库、没有 README。行内的套件按 `import.meta.url` 找自己的路径
// （所以它装到哪儿都能跑），一旦让它去读 `..\README.md`，就把"这个测试能不能跑"绑死在仓库布局上：
// 装机之后它要么找不到文件、要么得靠"文件不在就跳过"糊过去——而**跳过就是假绿**，
// 那比没有这个检查更坏（它看起来在守着，其实什么都没守）。
// 所以这个守卫住在仓库根、只属于仓库：它读的就是仓库里那两份文件的关系。
//
// 它还可以被单独的会话直接调用来当回归验证：`node check-version.mjs`；路径可用
// `--root <dir>` 覆盖（自测用，也方便以后从别处调用）。
//
// 修法是改 README 或改 VERSION，**不是**改这个脚本。
//
// 2026-10-01：测试区（`test-kaz\` -> `C:\Users\Kaczev\.dsh-test\.agent-presets\kaz`）按用户
// 决定整个删除（`.dsh-test` 与两个启动器已在更早一次清理里释放 1.81 GB，两个仓库只留下断链
// junction）。本守卫因此从"守护两处 VERSION"收窄成"守护 `kaz\VERSION` 一处"：原先那段
// "README 与两区都要相符、测试行领先一个后缀是既定状态"的说明随之作废，现在只有一条判据。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const ROOT = rootFlag >= 0 && args[rootFlag + 1] !== undefined ? resolve(args[rootFlag + 1]) : resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

const README = join(ROOT, "README.md");
const VERSIONS = [join(ROOT, "kaz", "VERSION")];
const SHAPE = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.]+)?$/u;

const problems = [];

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch (error) {
  console.error(`FAIL cannot read ${README}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// README 里出现**好几个**版本号形状的串（`0.2.0-rc.2` 是 dsh 运行时的要求），所以不能取"第一个"。
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
const published = versions[0];

if (sentence !== null && published !== null) {
  const stated = sentence[1];
  if (published.main !== stated) {
    problems.push(`README.md says 当前版本 ${stated}, but kaz\\VERSION (the published row) says ${published.value}`);
  }
  if (problems.length === 0) {
    console.log(`OK README 当前版本 ${stated} == kaz\\VERSION ${published.value}`);
  }
}

for (const problem of problems) console.error(`FAIL ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
