#!/usr/bin/env node
// Registration probe — verifies the Stage 3 deployment surface for
// kaz-skill-safe-json / safe_json_write. Run AFTER npm install.
// Exit code 0 only when ALL checks pass.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const profile = path.join(
  process.env.DSH_HOME || "C:\\Users\\Kaczev\\.dsh",
  "profiles",
  "web",
);
const presetAgent = path.join(
  process.env.DSH_HOME || "C:\\Users\\Kaczev\\.dsh",
  ".agent-presets",
  "kaz",
  "agent.cordis.yml",
);

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.log(
      `[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function containsText(file, needle) {
  return fs.readFileSync(file, "utf8").includes(needle);
}

check("repo skill manifest exists and is active", () => {
  const manifest = readJson(
    path.join(repoRoot, "KazPlugins", "kaz-skill-safe-json", "skills", "safe-json-write", "manifest.json"),
  );
  if (manifest.status !== "active") throw new Error(`status=${manifest.status}`);
});

check("repo switch.json enabled", () => {
  const sw = readJson(
    path.join(repoRoot, "KazPlugins", "kaz-skill-safe-json", "skills", "safe-json-write", "switch.json"),
  );
  if (sw.enabled !== true) throw new Error("enabled is not true");
});

check("project other-tool-plugin.json enables kaz-skill-safe-json", () => {
  const data = readJson(path.join(repoRoot, ".dsh", "storages", "other-tool-plugin.json"));
  if (data["kaz-skill-safe-json"] !== true) throw new Error("plugin not enabled");
});

check("project other-tool-plugin-catalog.json enables safe_json_write", () => {
  const data = readJson(path.join(repoRoot, ".dsh", "storages", "other-tool-plugin-catalog.json"));
  if (data["kaz-skill-safe-json"]?.["safe_json_write"] !== true) {
    throw new Error("tool not enabled");
  }
});

check("kaz_tool_auto_on plan list includes safe_json_write", () => {
  const data = readJson(path.join(repoRoot, ".dsh", "storages", "ka_tool_auto_on_setting.json"));
  if (!data.plan?.tools?.includes("safe_json_write")) {
    throw new Error("safe_json_write not in plan.tools");
  }
});

check("profile package.json depends on kaz-skill-safe-json", () => {
  const pkg = readJson(path.join(profile, "package.json"));
  if (pkg.dependencies?.["kaz-skill-safe-json"] !== "file:KazPlugins/kaz-skill-safe-json") {
    throw new Error("dependency missing or wrong");
  }
});

check("profile KazPlugins copy exists", () => {
  const dir = path.join(profile, "KazPlugins", "kaz-skill-safe-json");
  if (!fs.existsSync(path.join(dir, "lib", "index.js"))) throw new Error("lib/index.js missing");
  if (!fs.existsSync(path.join(dir, "skills", "safe-json-write", "lib", "core.mjs"))) throw new Error("core.mjs missing");
});

check("profile node_modules resolves kaz-skill-safe-json", () => {
  const entry = path.join(profile, "node_modules", "kaz-skill-safe-json", "lib", "index.js");
  if (!fs.existsSync(entry)) throw new Error("node_modules entry missing");
});

check("kaz/agent.cordis.yml contains relative mount row", () => {
  if (!containsText(presetAgent, "../../profiles/web/KazPlugins/kaz-skill-safe-json/lib/index.js")) {
    throw new Error("mount row not found");
  }
});

check("web cordis.patch.yml does NOT contain kaz-skill-safe-json", () => {
  const patch = path.join(profile, "cordis.patch.yml");
  if (fs.existsSync(patch) && containsText(patch, "kaz-skill-safe-json")) {
    throw new Error("plugin leaked into web-level cordis.patch.yml");
  }
});

{
  try {
    const entry = path.join(profile, "node_modules", "kaz-skill-safe-json", "lib", "index.js");
    const mod = await import(pathToFileURL(entry).href);
    if (mod.default?.name !== "kaz-skill-safe-json") {
      throw new Error(`unexpected default name: ${mod.default?.name}`);
    }
    passed++;
    console.log("[PASS] plugin package imports from profile node_modules");
  } catch (error) {
    failed++;
    console.log(
      `[FAIL] plugin package imports from profile node_modules: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failed > 0) {
  console.error(`probe-registration.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-registration.mjs ALL PASS (${passed})`);
}
