// Task-master-whiteboard logic probe: runs the plugin against a mock ctx,
// then exercises all six tools against a temporary workspace directory.
// Run: node task-master-whiteboard/probe-task-master-whiteboard.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/task-master-whiteboard/lib/index.js";
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label, condition, extra = "") {
  if (condition) {
    console.log("  PASS  " + label);
  } else {
    failures += 1;
    console.log("  FAIL  " + label + (extra ? "  -- " + extra : ""));
  }
}

// ---- mock ctx ------------------------------------------------------------
const sections = [];
const registeredTools = [];
const settingsSections = new Map();
const fakeSettings = {
  register(ns, schema, opts = {}) {
    settingsSections.set(ns, { ...(opts.base ?? {}), user: {} });
    const scope = () => ({ ...(opts.base ?? {}), ...(settingsSections.get(ns).user ?? {}) });
    return {
      get: scope,
      watch: () => () => {},
      update: (patch) => {
        settingsSections.get(ns).user = { ...(settingsSections.get(ns).user ?? {}), ...patch };
        return Promise.resolve();
      },
      replace: (section) => {
        settingsSections.get(ns).user = { ...section };
        return Promise.resolve();
      },
    };
  },
  get: (ns) => settingsSections.get(ns)?.user ?? {},
  update: (ns, patch) => {
    settingsSections.get(ns).user = { ...(settingsSections.get(ns).user ?? {}), ...patch };
    return Promise.resolve();
  },
  mutate: (ns, ops) => {
    const user = { ...(settingsSections.get(ns).user ?? {}) };
    for (const op of ops) {
      if (op.op === "set") user[op.path[0]] = op.value;
      else delete user[op.path[0]];
    }
    settingsSections.get(ns).user = user;
    return Promise.resolve();
  },
  describe: () => [],
};
const rdReports = [];
const ctx = {
  logger: { info: () => {}, warn: (m) => console.log("  [warn] " + m), error: () => {} },
  get: (name) => (name === "roundDisplay" ? { report: (r) => rdReports.push(r) } : undefined),
  on: () => {},
  fiber: { state: 0 },
  inject: (_deps, cb) => {
    cb({
      settings: fakeSettings,
      effect: (fn) => {
        const cleanup = fn();
        return typeof cleanup === "function" ? cleanup : () => {};
      },
    });
  },
  systemPrompt: { section: (s) => sections.push(s) },
  tools: { register: (t) => registeredTools.push(t) },
  settings: fakeSettings,
};

const tempWorkspace = mkdtempSync(join(tmpdir(), "twb-probe-"));
const exec = { agent: { id: "session-probe-1", session: { header: { cwd: tempWorkspace, id: "session-probe-1" } } } };
const execOther = { agent: { id: "session-probe-2", session: { header: { cwd: tempWorkspace, id: "session-probe-2" } } } };
const execSub = { agent: { id: "sub-probe-1", session: { header: { cwd: tempWorkspace, id: "sub-probe-1", parentSession: "session-probe-1", origin: "subagent" } } } };

console.log("task-master-whiteboard probe");
console.log("workspace: " + tempWorkspace);

// ---- apply ---------------------------------------------------------------
await plugin.apply(ctx, { enabled: true });
check("plugin name is task-master-whiteboard", plugin.name === "task-master-whiteboard");
check("inject declares systemPrompt + tools", Array.isArray(plugin.inject) && plugin.inject.includes("systemPrompt") && plugin.inject.includes("tools"));

// ---- role section (first round only) --------------------------------------
const roleSection = sections.find((s) => s.name === "task-master-whiteboard:role");
check("role section registered", roleSection !== undefined);
const freshAgent = { id: "fresh-1", session: { header: { cwd: tempWorkspace }, events: [] } };
const resumedAgent = { id: "resumed-1", session: { header: { cwd: tempWorkspace }, events: [{ type: "user/message" }] } };
const firstRoundText = roleSection?.text?.({ agent: freshAgent });
check(
  "role section reports to round-display on the first round",
  rdReports.length === 1 &&
    rdReports[0].plugin === "task-master-whiteboard" &&
    rdReports[0].title === "role" &&
    typeof rdReports[0].content === "string" &&
    rdReports[0].content.includes("Task Master"),
);
check(
  "role section renders Task Master text on the first round",
  typeof firstRoundText === "string" &&
    firstRoundText.includes("Task Master") &&
    firstRoundText.includes("top") &&
    firstRoundText.includes("whiteboards"),
);
const laterRoundText = roleSection?.text?.({ agent: freshAgent });
check("role section renders nothing on later rounds (first round only)", laterRoundText === "");

// ---- per-turn whiteboard-first reminder (turn >= 2, incl. resumed after restart) ----
const resumedAtTurn2 = { id: "resumed-2", session: { header: { cwd: tempWorkspace }, events: [{ type: "turn/start", data: { turn: 1 } }, { type: "user/message" }, { type: "turn/start", data: { turn: 2 } }] } };
const reminderText = roleSection?.text?.({ agent: resumedAtTurn2 });
check(
  "resumed conversation at turn 2 gets the per-turn reminder",
  typeof reminderText === "string" &&
    reminderText.includes("task-master-whiteboard reminder") &&
    reminderText.includes("new_whiteboard") &&
    reminderText.includes("read_whiteboard"),
);
check("per-turn reminder reports to round-display", rdReports.some((r) => r.plugin === "task-master-whiteboard" && r.title === "reminder"));
const resumedAtTurn2Again = roleSection?.text?.({ agent: resumedAtTurn2 });
check("per-turn reminder repeats every round (turn >= 2)", resumedAtTurn2Again === reminderText);
check("role section skips resumed conversations at turn < 2", roleSection?.text?.({ agent: resumedAgent }) === "");
check("role section renders nothing when disabled", (() => {
  ctx.settings.update("task-master-whiteboard", { enabled: false });
  const out = roleSection.text({ agent: { id: "fresh-2", session: { header: { cwd: tempWorkspace }, events: [] } } });
  ctx.settings.update("task-master-whiteboard", { enabled: true });
  return out === "";
})());

// ---- six tools registered ---------------------------------------------------
const byName = new Map(registeredTools.map((t) => [t.name, t]));
for (const expected of ["new_whiteboard", "list_whiteboards", "read_whiteboard", "append_whiteboard", "update_whiteboard", "clear_whiteboard"]) {
  check("tool registered: " + expected, byName.has(expected));
}

// ---- tool behaviors ---------------------------------------------------------
const boardsDir = join(tempWorkspace, ".dsh", "whiteboards", "session-probe-1");

const newBoard = await byName.get("new_whiteboard").execute(
  { top: "Current task subtasks", entries: [{ subtitle: "alpha", content: "first" }, { subtitle: "beta", content: "second" }] },
  exec,
);
check("new_whiteboard returns id/top/entries", /^wb_[0-9]+_[a-z0-9]{4}$/.test(newBoard.id) && newBoard.top === "Current task subtasks" && newBoard.entries.length === 2);
const boardId = newBoard.id;
check("new_whiteboard creates .dsh/whiteboards/ + file", existsSync(join(boardsDir, boardId + ".json")));

const listed = await byName.get("list_whiteboards").execute({}, exec);
check("list_whiteboards lists the board", Array.isArray(listed) && listed.some((b) => b.id === boardId && b.top === "Current task subtasks"));
// ---- per-conversation scoping ----
const listedOther = await byName.get("list_whiteboards").execute({}, execOther);
check("list_whiteboards is empty in another conversation (per-session scope)", Array.isArray(listedOther) && listedOther.length === 0);
const listedSub = await byName.get("list_whiteboards").execute({}, execSub);
check("subagent shares its parent conversation's boards", Array.isArray(listedSub) && listedSub.some((b) => b.id === boardId));
const subBoard = await byName.get("new_whiteboard").execute({ top: "sub board" }, execSub);
check("subagent-created board lands in the parent session scope", existsSync(join(boardsDir, subBoard.id + ".json")));
const listedOther2 = await byName.get("list_whiteboards").execute({}, execOther);
check("other conversation still cannot see subagent-created board", Array.isArray(listedOther2) && !listedOther2.some((b) => b.id === subBoard.id));

const outline = await byName.get("read_whiteboard").execute({ id: boardId }, exec);
check("read_whiteboard (no subtitle) lists subtitles only", Array.isArray(outline.subtitles) && outline.subtitles.length === 2 && outline.subtitles.includes("alpha") && outline.subtitles[0] === "alpha" && !("content" in outline));

const oneEntry = await byName.get("read_whiteboard").execute({ id: boardId, subtitle: "alpha" }, exec);
check("read_whiteboard (subtitle) returns content", oneEntry.subtitle === "alpha" && oneEntry.content === "first");

const appended = await byName.get("append_whiteboard").execute({ id: boardId, subtitle: "gamma", content: "third" }, exec);
check("append_whiteboard adds a new entry", appended.total === 3 && appended.updated === false);

const overwritten = await byName.get("append_whiteboard").execute({ id: boardId, subtitle: "alpha", content: "first v2" }, exec);
check("append_whiteboard overwrites on duplicate subtitle", overwritten.updated === true && overwritten.total === 3);
const afterOverwrite = await byName.get("read_whiteboard").execute({ id: boardId, subtitle: "alpha" }, exec);
check("overwrite took effect", afterOverwrite.content === "first v2");

const updated = await byName.get("update_whiteboard").execute({ id: boardId, subtitle: "beta", content: "second v2" }, exec);
check("update_whiteboard updates existing entry", updated.created === false && updated.entry.content === "second v2");
const created = await byName.get("update_whiteboard").execute({ id: boardId, subtitle: "delta", content: "fourth" }, exec);
check("update_whiteboard creates when missing", created.created === true && created.total === 4);

const clearedEntry = await byName.get("clear_whiteboard").execute({ id: boardId, subtitle: "delta" }, exec);
check("clear_whiteboard removes one entry", clearedEntry.removedSubtitle === "delta" && clearedEntry.remaining === 3);

const clearedBoard = await byName.get("clear_whiteboard").execute({ id: boardId }, exec);
check("clear_whiteboard deletes the whole board file", clearedBoard.deleted === true && !existsSync(join(boardsDir, boardId + ".json")));

// ---- error handling ---------------------------------------------------------
let threw = false;
try { await byName.get("read_whiteboard").execute({ id: boardId }, exec); } catch { threw = true; }
check("read_whiteboard on missing board throws", threw);

threw = false;
try { await byName.get("new_whiteboard").execute({ top: "x", entries: "nope" }, exec); } catch { threw = true; }
check("new_whiteboard rejects invalid entries", threw);

threw = false;
try { await byName.get("read_whiteboard").execute({ id: "..\\evil", }, exec); } catch { threw = true; }
check("path traversal id rejected", threw);

// ---- file format check -------------------------------------------------------
const newBoard2 = await byName.get("new_whiteboard").execute({ top: "format check" }, exec);
const raw = readFileSync(join(boardsDir, newBoard2.id + ".json"), "utf8");
check("board file is pretty JSON with top/entries", raw.startsWith("{\n  \"id\":") && raw.includes("\"top\": \"format check\"") && raw.includes("\"entries\": []"));

// cleanup
rmSync(tempWorkspace, { recursive: true, force: true });
console.log("remaining probe files: " + (readdirSync(tmpdir()).filter((n) => n.startsWith("twb-probe-")).length));

if (failures === 0) {
  console.log("PROBE OK");
} else {
  console.log("PROBE FAILED: " + failures + " failure(s)");
  process.exit(1);
}
