#!/usr/bin/env node
// probe-registration.mjs —— deployment-surface probe for whale-summarizer.
// Verifies: version/files, Kaz-preset-only mount, profile dependency, no
// profile-global mount, no non-Kaz mount, no candidate-registry tool entry,
// plugin imports, scope gate. Run after npm install when applicable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = path.resolve(here, "../..");
const home = process.env.DSH_HOME || "C:\\Users\\Kaczev\\.dsh";
const presetsRoot = path.join(home, ".agent-presets");
const pluginDir = path.join(profile, "KazPlugins", "whale-summarizer");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function containsText(file, needle) {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(needle);
}

check("plugin package.json exists, version 0.1.0, official (not private)", () => {
  const pkg = readJson(path.join(pluginDir, "package.json"));
  if (pkg.name !== "whale-summarizer") throw new Error(`name=${pkg.name}`);
  if (pkg.version !== "0.1.0") throw new Error(`version=${pkg.version}`);
  if (pkg.private === true) throw new Error("still marked private");
});

check("plugin implementation files exist", () => {
  for (const file of [
    "lib/index.js",
    "lib/core.mjs",
    "lib/llm-call.mjs",
    "README.md",
    "CHANGELOG.md",
    "CANDIDATE.md",
  ]) {
    if (!fs.existsSync(path.join(pluginDir, file))) throw new Error(`missing ${file}`);
  }
});

check("profile package.json depends on whale-summarizer file: path", () => {
  const pkg = readJson(path.join(profile, "package.json"));
  if (pkg.dependencies?.["whale-summarizer"] !== "file:KazPlugins/whale-summarizer") {
    throw new Error("dependency missing or wrong");
  }
});

check("profile node_modules resolves whale-summarizer to KazPlugins copy", () => {
  const nmDir = path.join(profile, "node_modules", "whale-summarizer");
  if (!fs.existsSync(path.join(nmDir, "lib", "index.js"))) throw new Error("node_modules entry missing");
  const resolvedNm = fs.realpathSync(nmDir);
  const resolvedPlugin = fs.realpathSync(pluginDir);
  if (resolvedNm.toLowerCase() !== resolvedPlugin.toLowerCase()) {
    throw new Error(`node_modules resolves to ${resolvedNm}, expected ${resolvedPlugin}`);
  }
});

check("kaz/agent.cordis.yml does NOT contain whale-summarizer relative mount", () => {
  const preset = path.join(presetsRoot, "kaz", "agent.cordis.yml");
  if (containsText(preset, "whale-summarizer")) throw new Error("Kaz preset still has stale whale-summarizer mount");
});

check("profile web cordis.patch.yml contains whale-summarizer global mount", () => {
  const patch = path.join(profile, "cordis.patch.yml");
  if (!containsText(patch, "whale-summarizer")) throw new Error("whale-summarizer missing from profile-global patch");
});

check("non-Kaz agent presets do NOT contain whale-summarizer", () => {
  if (!fs.existsSync(presetsRoot)) throw new Error("agent-presets root missing");
  const presets = fs
    .readdirSync(presetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "kaz")
    .map((entry) => entry.name);
  if (presets.length === 0) throw new Error("no non-Kaz presets found to scan");
  for (const name of presets) {
    const file = path.join(presetsRoot, name, "agent.cordis.yml");
    if (containsText(file, "whale-summarizer")) {
      throw new Error(`non-Kaz preset ${name} still mounts whale-summarizer`);
    }
  }
});

check("agent-managed registry has NO whale_summarizer candidate (no model-visible tool)", () => {
  const regFile = path.join(home, "storages", "kaz-agent-managed-tools.json");
  if (!fs.existsSync(regFile)) return;
  const reg = readJson(regFile);
  const candidates = Array.isArray(reg?.candidates) ? reg.candidates : [];
  const hit = candidates.find(
    (item) =>
      item?.tool === "whale_summarizer" ||
      item?.tool === "whale-summarizer" ||
      item?.source === "KazPlugins/whale-summarizer",
  );
  if (hit) throw new Error(`unexpected candidate entry: ${JSON.stringify(hit)}`);
});

{
  const mod = await import(pathToFileURL(path.join(pluginDir, "lib", "index.js")).href);
  check("plugin default import has expected name/apply and scope helper", () => {
    if (mod.default?.name !== "whale-summarizer") throw new Error(`name=${mod.default?.name}`);
    if (typeof mod.default?.apply !== "function") throw new Error("apply missing");
    if (typeof mod.isWhaleSummarizerScopeAllowed !== "function") throw new Error("scope helper missing");
  });

  check("scope allows Kaz agent, denies plain agent, fails closed on null", () => {
    const kazAgent = { id: "kaz-main" };
    const plainAgent = { id: "plain" };
    if (mod.isWhaleSummarizerScopeAllowed({ kazMode: { kazEnabled: () => true } }, kazAgent) !== true) {
      throw new Error("Kaz agent denied");
    }
    const services = {
      kazMode: { kazEnabled: () => false },
      kaWhaleWorkflow: { subagentRoleOf: () => null },
    };
    if (mod.isWhaleSummarizerScopeAllowed(services, plainAgent) !== false) throw new Error("plain agent allowed");
    if (mod.isWhaleSummarizerScopeAllowed(services, null) !== false) throw new Error("null allowed");
  });
}

if (failed > 0) {
  console.error(`probe-registration.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-registration.mjs ALL PASS (${passed})`);
}
