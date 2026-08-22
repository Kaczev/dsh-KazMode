#!/usr/bin/env node
// 检查 Kaz 模式版本号是否和发版状态一致。
// 用法：node KazPlugins/kaz-mode/check-version.mjs
// 作用：当最新 tag 之后有新提交、但 package.json 的 version 还没升版本时，提醒“未来的我 / agent”更新版本号。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_FILE = join(HERE, "package.json");
// 优先使用运行目录（从仓库根目录执行最常用），否则退回按脚本位置推导仓库根。
const REPO_ROOT = existsSync(join(process.cwd(), ".git")) ? process.cwd() : join(HERE, "..", "..");

let current = "";
try {
  const raw = readFileSync(PACKAGE_FILE, "utf8").replace(/^\uFEFF/, "");
  const data = JSON.parse(raw);
  current = typeof data.version === "string" ? data.version.trim() : "";
} catch (error) {
  console.error("❌ 读取 package.json 失败：" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

if (current.length === 0) {
  console.error("❌ package.json 缺少 version 字段。");
  process.exit(1);
}

let tag = "";
try {
  tag = execFileSync("git", ["-C", REPO_ROOT, "describe", "--tags", "--abbrev=0"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
} catch {
  console.warn("⚠ 无法读取 git tag（可能还没有 tag 或不在 git 仓库），跳过版本核对。");
  console.warn(`   当前 package.json version = ${current}`);
  process.exit(0);
}

const norm = (value) => String(value || "").replace(/^v/i, "");

let ahead = 0;
try {
  ahead = Number.parseInt(
    execFileSync("git", ["-C", REPO_ROOT, "rev-list", "--count", `${tag}..HEAD`], {
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
    10,
  );
} catch {
  ahead = 0;
}

if (ahead > 0 && norm(current) === norm(tag)) {
  console.error(`⚠ 最新 tag 是 ${tag}，但之后还有 ${ahead} 个提交，而 package.json 的 version 仍是 ${current}。`);
  console.error("   如果这是新版本，请先更新 KazPlugins/kaz-mode/package.json 的 version 字段。");
  console.error("   例如改成：" + tag.replace(/(\d+)$/, (m) => String(Number(m) + 1)));
  process.exit(1);
}

console.log(`✅ package.json version = ${current}，最新 git tag = ${tag}，版本状态正常。`);
