// sync-skill.mjs —— 把 write-like-a-person 技能仓库的正文同步进预设。
//
// 为什么需要它：技能有自己的仓库（Kaz 之外的环境也能用），但 Kaz 预设必须自包含——
// 使用者把 kaz\ 当 bundle 装走时，不会顺手 clone 第二个仓库。所以这里存一份拷贝，
// 并且把来源 commit 记在旁边，让两份内容对得上号。
//
// 拷贝是单向的：技能仓库是唯一源，kaz\skills\ 下的这份不该被直接编辑，下次同步会覆盖它。
//
// 源仓库默认在仓库同级目录（..\write-like-a-person），可用 --from <路径> 或环境变量
// WLAP_REPO 覆盖。--verify 只比对不写入，退出码 1 表示两边不一致，给发布前检查用。
// （不要叫 --check：ELECTRON_RUN_AS_NODE 起的进程会把它当 Node 自己的参数吃掉。）
//
// 只搬 SKILL.md 和两个可选目录（references/、examples/）。README、LICENSE 属于技能仓库
// 自己的门面，不随预设发出去。要加新的资源目录，改下面的 COPY_DIRS。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_NAME = "write-like-a-person";
const DEST = join(ROOT, "kaz", "skills", SKILL_NAME);
const MANIFEST = join(DEST, "SOURCE.json");
const FIXED_FILES = ["SKILL.md"];
const COPY_DIRS = ["references", "examples"];

const args = process.argv.slice(2);
const checkOnly = args.includes("--verify");
const fromFlag = args.indexOf("--from");
const fromIndex = fromFlag >= 0 ? args[fromFlag + 1] : undefined;
const SOURCE = resolve(fromIndex ?? process.env.WLAP_REPO ?? join(ROOT, "..", SKILL_NAME));

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function listFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listFiles(full)) found.push(join(entry.name, nested));
    } else if (entry.isFile()) {
      found.push(entry.name);
    }
  }
  return found.sort();
}

if (!existsSync(SOURCE) || !statSync(SOURCE).isDirectory()) {
  fail(`skill repository not found at ${SOURCE} — pass --from <path> or set WLAP_REPO`);
}

const skillPath = join(SOURCE, "SKILL.md");
if (!existsSync(skillPath)) fail(`no SKILL.md in ${SOURCE}`);

const skillText = readFileSync(skillPath, "utf8");
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillText);
if (frontmatter === null || !new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "mu").test(frontmatter[1])) {
  fail(`${skillPath}: frontmatter must have \`name: ${SKILL_NAME}\``);
}

function git(cwd, ...rest) {
  return execFileSync("git", ["-C", cwd, ...rest], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let ref = "";
let repo = "";
let dirty = false;
try {
  ref = git(SOURCE, "rev-parse", "--abbrev-ref", "HEAD");
  dirty = git(SOURCE, "status", "--porcelain", "--untracked-files=no") !== "";
  if (git(SOURCE, "remote").split("\n").includes("origin")) {
    repo = git(SOURCE, "remote", "get-url", "origin");
  }
} catch {
  fail(`${SOURCE} is not a git repository — the synced copy records a commit, so the source must have one`);
}

// 把常见 remote 形状收成 https 形式，方便在 SOURCE.json 里点开。
function normalizeRemote(url) {
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/u.exec(url);
  if (ssh !== null) return `https://github.com/${ssh[1]}`;
  return url.replace(/\.git$/u, "");
}

const files = [...FIXED_FILES];
for (const dir of COPY_DIRS) {
  const full = join(SOURCE, dir);
  if (!existsSync(full)) continue;
  for (const nested of listFiles(full)) files.push(`${dir}/${nested.replace(/\\/gu, "/")}`);
}

// 记「这份正文最后一次由哪次提交改出来」，不是源仓库当前 HEAD。
// 源仓库只改 README / workflow 时，两条同步路径才不会各记一个不同的 commit。
let commit = "";
try {
  commit = git(SOURCE, "log", "-1", "--format=%H", "--", ...files);
  if (commit === "") commit = git(SOURCE, "rev-parse", "HEAD");
} catch {
  fail(`${SOURCE}: could not read the commit that last changed the synced files`);
}

const payload = files.map((rel) => ({ rel, data: readFileSync(join(SOURCE, rel)) }));
const digest = sha256(
  payload.map(({ rel, data }) => Buffer.concat([Buffer.from(`${rel}\0`), data])).join(""),
);

const expected = {
  repo: normalizeRemote(repo),
  ref,
  commit,
  dirty,
  contentSha256: digest,
};

function manifestMismatch() {
  if (!existsSync(MANIFEST)) return "SOURCE.json missing";
  let current;
  try {
    current = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    return `SOURCE.json unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
  // 只比内容哈希。源仓库改 README、改 LICENSE 这类不随预设发出去的提交不该让这里失败；
  // SOURCE.json 里的 commit 记的是「这份正文抄自哪一次提交」，不是「源仓库当前 HEAD」。
  if (current.contentSha256 !== expected.contentSha256) {
    return `SOURCE.json contentSha256: ${JSON.stringify(current.contentSha256)} != ${JSON.stringify(expected.contentSha256)}`;
  }
  return null;
}

function contentMismatch() {
  for (const { rel, data } of payload) {
    const target = join(DEST, rel);
    if (!existsSync(target)) return `${rel} missing in presets`;
    if (!readFileSync(target).equals(data)) return `${rel} differs`;
  }
  return manifestMismatch();
}

const mismatch = existsSync(DEST) ? contentMismatch() : "destination missing";

if (checkOnly) {
  if (mismatch !== null) fail(`presets out of sync: ${mismatch} — run node scripts/sync-skill.mjs`);
  console.log(`OK ${SKILL_NAME} in presets matches ${SOURCE} (${digest.slice(0, 12)})`);
  process.exit(0);
}

if (mismatch === null) {
  console.log(`OK ${SKILL_NAME} already in sync (${digest.slice(0, 12)})`);
  process.exit(0);
}

if (dirty) {
  console.warn(`WARN ${SOURCE} has uncommitted changes — the recorded commit does not describe the copied text`);
}

// 不删整个目录再重建：桌面端可能正开着它，Windows 会短暂拒绝重建。
// 就地覆盖，再清掉这次没带过来的旧文件。
mkdirSync(DEST, { recursive: true });
const keep = new Set([...files.map((rel) => join(DEST, rel)), MANIFEST]);
function removeStale(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeStale(full);
      // 空目录也必须带 recursive：rmSync 对目录不带 recursive 会抛 EISDIR。
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
    } else if (!keep.has(full)) {
      rmSync(full, { force: true });
    }
  }
}
removeStale(DEST);
for (const { rel, data } of payload) {
  const target = join(DEST, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}
writeFileSync(MANIFEST, `${JSON.stringify(expected, null, 4)}\n`);

console.log(`synced ${SKILL_NAME} -> ${relative(ROOT, DEST)}`);
console.log(`  from ${SOURCE}`);
console.log(`  commit ${commit.slice(0, 12)}${ref ? ` (${ref})` : ""}${dirty ? " + uncommitted changes" : ""}`);
console.log(`  ${payload.length} file(s): ${files.join(", ")}`);
