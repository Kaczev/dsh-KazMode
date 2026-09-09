// ka-whale-workflow prompt-hygiene 永久回归锁：
//   1) 所有 model-visible prompt 文本不得出现版本/阶段 token（7.x / v0.x / Pn）：
//      KAZ_ROLE_PROMPTS 四条 + FIRST_ROUND_STARTUP_TEXT + KAZ_SUBAGENT_FALLBACK_PROMPT +
//      stageInjectionText(role, stage) 全部主/子阶段（含 minimalTools 变体）+
//      已注册工具的 description 与参数 description；
//   2) assess-complexity allowedTools 必须精确等于 10 项只读侦查集；
//   3) assess task 必须常驻四项 S 条件、只读纪律、tierSignals 格式、delivery-gate 规则，
//      且长度 ≤ 1500（打印实际长度）。
// 防空跑：扫描前先断言六个 prompt-bearing 工具已注册；正则先做正/负样本自检。
// 运行：node KazPlugins/ka-whale-workflow/probe-prompt-hygiene.mjs
import plugin, {
  createStageStore,
  V09_SUBAGENT_ROLE_INITIAL_STAGES,
  SUB_WHALE_REPORT_WAIT_NOTICE,
  SUB_WHALE_REPORT_WAIT_DENY_CODE,
} from "./lib/index.js";
import {
  MAIN_ROLE,
  MAIN_STAGE_IDS,
  WORKER_STAGE_IDS,
  MEMORY_MAINTAINER_STAGE_IDS,
  PLUGIN_MAINTAINER_STAGE_IDS,
  FIRST_ROUND_STARTUP_TEXT,
  stageDefinitionFor,
  stageInjectionText,
} from "./lib/stage-defs.js";
import { KAZ_ROLE_PROMPTS, KAZ_SUBAGENT_FALLBACK_PROMPT } from "kaz-shared";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// --- 版本/阶段 token 扫描器（任务规定正则；每次新建避免 /g lastIndex 泄漏） ---
const versionTokenRegex = () =>
  /(?:^|[^A-Za-z0-9])(7\.[0-9]+|v0\.[0-9]+|P[0-9]+)(?![A-Za-z0-9])/g;

function versionTokensIn(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const re = versionTokenRegex();
  const hits = [];
  let match;
  while ((match = re.exec(text)) !== null) hits.push(match[1]);
  return hits;
}

// 防空跑锁 1：正则自检（必须能抓，也必须不误抓）。
{
  const mustMatch = ["7.4", "v0.9", "P12", "x 7.4 y", "（v0.9）", "P1."];
  const mustNotMatch = ["17.4", "v0.90x", "SP1", "P1x", "P", "v0."];
  const missed = mustMatch.filter((sample) => versionTokensIn(sample).length === 0);
  const falsePositive = mustNotMatch.filter((sample) => versionTokensIn(sample).length > 0);
  check(
    "regex self-test: matches 7.4/v0.9/P12 and rejects 17.4/v0.90x/SP1/P1x",
    missed.length === 0 && falsePositive.length === 0,
  );
}

// --- 收集 model-visible 文本 ---
const personaTexts = [
  ["KAZ_ROLE_PROMPTS.main", KAZ_ROLE_PROMPTS.main],
  ["KAZ_ROLE_PROMPTS.subagent.worker", KAZ_ROLE_PROMPTS.subagent.worker],
  ["KAZ_ROLE_PROMPTS.subagent.memoryMaintainer", KAZ_ROLE_PROMPTS.subagent.memoryMaintainer],
  ["KAZ_ROLE_PROMPTS.subagent.pluginMaintainer", KAZ_ROLE_PROMPTS.subagent.pluginMaintainer],
  ["KAZ_SUBAGENT_FALLBACK_PROMPT", KAZ_SUBAGENT_FALLBACK_PROMPT],
  ["FIRST_ROUND_STARTUP_TEXT", FIRST_ROUND_STARTUP_TEXT],
];
check(
  "four KAZ_ROLE_PROMPTS texts + startup/fallback texts are non-empty strings",
  personaTexts.length === 6 &&
    personaTexts.every(([, text]) => typeof text === "string" && text.length > 0),
);

const stagePairs = [
  ...MAIN_STAGE_IDS.map((stage) => [MAIN_ROLE, stage]),
  ...WORKER_STAGE_IDS.map((stage) => ["worker", stage]),
  ...MEMORY_MAINTAINER_STAGE_IDS.map((stage) => ["memoryMaintainer", stage]),
  ...PLUGIN_MAINTAINER_STAGE_IDS.map((stage) => ["pluginMaintainer", stage]),
];
const stageTexts = stagePairs.map(([role, stage]) => [
  `stageInjectionText(${role}, ${stage})`,
  stageInjectionText(role, stage),
]);
for (const [role, stage] of [
  [MAIN_ROLE, "assess-complexity"],
  ...Object.entries(V09_SUBAGENT_ROLE_INITIAL_STAGES),
]) {
  stageTexts.push([
    `stageInjectionText(${role}, ${stage}, {minimalTools})`,
    stageInjectionText(role, stage, { minimalTools: ["memory_search", "context_search"] }),
  ]);
}
check(
  "stageInjectionText covers all 18 main/subagent stages plus 4 minimal variants and none is empty",
  stageTexts.length === 22 &&
    stageTexts.every(([, text]) => typeof text === "string" && text.length > 0),
);

// --- 插件 harness（模式照搬 probe-kaz74-gate.mjs 的 makeBase） ---
function makeBase({ includeSubagents = true } = {}) {
  const listeners = new Map();
  const registeredTools = new Map();
  const provided = {};
  const roundReports = [];
  const settings = {
    register(ns, _schema, opts = {}) {
      let current = { ...(opts.base ?? {}) };
      return {
        get: () => ({ ...current }),
        watch: () => () => {},
        update: (patch) => {
          current = { ...current, ...patch };
          return Promise.resolve();
        },
      };
    },
    get: () => ({ enabled: true, includeSubagents }),
    update: () => Promise.resolve(),
  };
  const toolsMock = {
    register(def) {
      registeredTools.set(def.name, def);
      return () => registeredTools.delete(def.name);
    },
    schemas() {
      return [...registeredTools.keys()].map((name) => ({ name, description: "", parameters: {} }));
    },
    get(name) {
      return registeredTools.get(name);
    },
  };
  const agentRegistry = new Map();
  const mockKazMode = {
    pluginConfig: () => ({ enabled: true, includeSubagents }),
    toolVisible: () => true,
  };
  const base = {
    fiber: { state: 0 },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    async plugin() {
      return;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes("settings")) setImmediate(() => cb({ ...base, settings }));
    },
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    provide(name, value) {
      provided[name] = value;
      return () => {
        delete provided[name];
      };
    },
    get(name) {
      if (name in provided) return provided[name];
      if (name === "settings") return settings;
      if (name === "tools") return toolsMock;
      if (name === "kazMode") return mockKazMode;
      if (name === "agents") return { get: (id) => agentRegistry.get(id) };
      if (name === "roundDisplay") return { report: (payload) => roundReports.push(payload) };
      if (name === "subagents") {
        return { listChildren: async () => [], followup: async () => "msg", startContinuable: async () => ({}) };
      }
      return undefined;
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    tools: toolsMock,
  };
  return { listeners, registeredTools, provided, roundReports, base };
}

const TMP = mkdtempSync(join(tmpdir(), "whale-prompt-hygiene-"));
const STORE = join(TMP, "stage.json");
const seed = createStageStore(STORE);
seed.set("main", "assess-complexity");
seed.beginWorkflowRun("main");
const h = makeBase({ includeSubagents: true });
await plugin.apply(h.base, { stageStore: STORE, projectRoot: TMP });
await new Promise((resolve) => setTimeout(resolve, 30));

const EXPECTED_TOOLS = [
  "whale_report",
  "ka_sub_whale",
  "plan_read",
  "work_sub_whale_report",
  "memory_sub_whale_report",
  "plugin_maintainer_sub_whale_report",
];
check(
  `all six prompt-bearing tools registered (registry: ${[...h.registeredTools.keys()].join(", ")})`,
  EXPECTED_TOOLS.every((name) => h.registeredTools.has(name)) &&
    h.registeredTools.size >= EXPECTED_TOOLS.length,
);

function collectStrings(value, label, out, depth = 0) {
  if (depth > 8) return;
  if (typeof value === "string") {
    out.push([label, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${label}[${index}]`, out, depth + 1));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, `${label}.${key}`, out, depth + 1);
    }
  }
}

const toolTexts = [];
for (const [name, def] of h.registeredTools) {
  if (typeof def?.description === "string") {
    toolTexts.push([`tool:${name}.description`, def.description]);
  }
  collectStrings(def?.parameters ?? {}, `tool:${name}.parameters`, toolTexts);
}
check(
  `tool descriptions + parameter descriptions collected (${toolTexts.length} strings across ${h.registeredTools.size} tools)`,
  toolTexts.length > 0,
);

// --- 扫描：0 版本 token ---
const allTexts = [...personaTexts, ...stageTexts, ...toolTexts];
const tokenHits = [];
for (const [label, text] of allTexts) {
  const tokens = versionTokensIn(text);
  if (tokens.length > 0) tokenHits.push(`${label}: ${tokens.join(", ")}`);
}
check(
  `prompt hygiene: 0 version tokens across ${allTexts.length} model-visible strings`,
  tokenHits.length === 0,
);
if (tokenHits.length > 0) console.log("  version-token hits:", tokenHits.join(" | "));

// --- 静态扫描 lib/*.js 字符串字面量：new Error 文案 / reason 文案 / schema 文案 ---
// 注释与正则字面量必须跳过（index.js 注释里有 "<v0.9 stage>"），因此自带 tokenizer，
// 并用固定 fixtures 自检：行注释、块注释、模板字面量、字符串内转义引号、正则字面量。
function regexCanStart(prev) {
  return prev === "" || "(,=:[!&|?{};+-*%^~<>".includes(prev);
}

function extractStringLiterals(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  let prev = "";
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let text = "";
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === quote) break;
        if (c === "\n") break;
        text += c;
        j += 1;
      }
      out.push(text);
      i = j + 1;
      prev = quote;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let text = "";
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          text += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === "`") break;
        text += c;
        j += 1;
      }
      out.push(text);
      i = j + 1;
      prev = "`";
      continue;
    }
    if (ch === "/" && regexCanStart(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        j += 1;
      }
      i = j + 1;
      prev = "/";
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return out;
}

{
  const fixtureSource = [
    "// line comment v0.9 must be ignored",
    "/* block comment v0.9 must be ignored */",
    'const a = "x v0.9 y";',
    "const b = 'esc \\' quote';",
    'const c = `tpl ${a} v0.9`;',
    'const re = /[^/]+v0\\.9/;',
  ].join("\n");
  const fixtureLiterals = extractStringLiterals(fixtureSource);
  check(
    "literal tokenizer fixtures: comments + regex skipped; strings/templates/escapes captured",
    fixtureLiterals.length === 3 &&
      fixtureLiterals.includes("x v0.9 y") &&
      fixtureLiterals.includes("esc ' quote") &&
      fixtureLiterals.some((text) => text.includes("tpl ${a} v0.9")) &&
      !fixtureLiterals.some((text) => text.includes("must be ignored")),
  );
}

const libDirUrl = new URL("./lib/", import.meta.url);
const libFiles = readdirSync(libDirUrl)
  .filter((name) => name.endsWith(".js"))
  .sort();
const libLiteralTexts = [];
for (const name of libFiles) {
  const source = readFileSync(new URL(name, libDirUrl), "utf8");
  extractStringLiterals(source).forEach((text, index) => {
    libLiteralTexts.push([`lib/${name}#${index}`, text]);
  });
}
const LIB_LITERAL_FLOOR = 1500;
check(
  `lib/*.js string literals collected (${libLiteralTexts.length} across ${libFiles.length} files; floor ${LIB_LITERAL_FLOOR})`,
  libLiteralTexts.length >= LIB_LITERAL_FLOOR,
);

const libKnownTexts = [
  "evidence-command-shell-mismatch",
  "whale_report requires a calling agent",
  "Stage advanced; now output your full report as your final message",
];
check(
  "static scan captures p1 shell-mismatch reason, a new Error text, and the report wait notice",
  libKnownTexts.every((needle) => libLiteralTexts.some(([, text]) => text.includes(needle))),
);

const runtimeNoticeTexts = [
  ["SUB_WHALE_REPORT_WAIT_NOTICE", SUB_WHALE_REPORT_WAIT_NOTICE],
  ["SUB_WHALE_REPORT_WAIT_DENY_CODE", SUB_WHALE_REPORT_WAIT_DENY_CODE],
];
const libTokenHits = [];
for (const [label, text] of [...libLiteralTexts, ...runtimeNoticeTexts]) {
  const tokens = versionTokensIn(text);
  if (tokens.length > 0) libTokenHits.push(`${label}: ${tokens.join(", ")}`);
}
check(
  `error/notice hygiene: 0 version tokens across ${libLiteralTexts.length} lib literals + ${runtimeNoticeTexts.length} notice constants`,
  libTokenHits.length === 0,
);
if (libTokenHits.length > 0) console.log("  lib version-token hits:", libTokenHits.join(" | "));

// --- assess allowedTools 精确集合 ---
const EXPECTED_ASSESS_TOOLS = [
  "memory_search",
  "memory_detail",
  "memory_list",
  "context_search",
  "context_read",
  "read",
  "glob",
  "grep",
  "pwsh",
  "whale_report",
];
const assessDef = stageDefinitionFor(MAIN_ROLE, "assess-complexity");
check(
  "assess allowedTools exactly equals the 10-entry read-only recon set",
  JSON.stringify(assessDef?.allowedTools) === JSON.stringify(EXPECTED_ASSESS_TOOLS),
);
check(
  "assess allowedTools includes read/glob/grep/pwsh and excludes edit/write/ask_user_question/context_compress",
  ["read", "glob", "grep", "pwsh"].every((tool) => assessDef?.allowedTools.includes(tool)) &&
    ["edit", "write", "ask_user_question", "context_compress"].every(
      (tool) => !assessDef?.allowedTools.includes(tool),
    ),
);

// --- assess task 契约 ---
const assessTask = assessDef?.task ?? "";
check(
  "assess task carries the four machine-decidable S conditions",
  ["exactly 1 changed file", "no risk word", "an existing probe covers it", "that probe passes now"].every(
    (fragment) => assessTask.includes(fragment),
  ),
);
check(
  "assess task carries the read-only discipline",
  assessTask.includes("Read-only: never edit or git-write") &&
    assessTask.includes("only git status --porcelain, git diff --stat, rg/Select-String, node <probe>"),
);
check(
  "assess task carries tierReason + tierSignals formats (git-status:1, probe:<path>, probe-run:PASS)",
  assessTask.includes("tierReason") &&
    assessTask.includes("tierSignals") &&
    assessTask.includes("git-status:1, probe:<path>, probe-run:PASS"),
);
check(
  "assess task carries the delivery-gate rule (S false explicit / M externally verifiable / L true default)",
  assessTask.includes("S -> evidenceGate:false explicitly") &&
    assessTask.includes("M -> true when externally verifiable") &&
    assessTask.includes("L -> true by default"),
);
check(
  `assess task length <= 1500 (actual ${assessTask.length})`,
  assessTask.length > 0 && assessTask.length <= 1500,
);

rmSync(TMP, { recursive: true, force: true });
console.log(
  failures === 0 ? "\nPROMPT-HYGIENE PROBE OK" : `\nPROMPT-HYGIENE PROBE FAILED (${failures} 项失败)`,
);
process.exit(failures === 0 ? 0 : 1);
