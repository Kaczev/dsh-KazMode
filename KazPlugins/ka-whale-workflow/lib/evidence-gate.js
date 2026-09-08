// ka-whale-workflow —— 7.4 P3 evidence/delivery gate（ESM + child_process）
// §3.4/§9.1: unmet blocks; ≥1 mainRerun.matches=true; runner single 120s, no retry.
import { exec } from "node:child_process";
import { normalizeEvidenceChecklist } from "./intent-map.js";

export const MAIN_RERUN_TIMEOUT_MS = 120_000;
export const MAIN_RERUN_TAIL_CHAR_LIMIT = 4000;
export const NOT_VERIFIED_MAX_CHARS = 200;

export function normalizeNotVerifiedList(value) {
  if (value === undefined || value === null) return { notVerified: [], markers: ["notVerifiedMissing"] };
  if (!Array.isArray(value)) return { notVerified: [], markers: ["notVerifiedInvalid"] };
  const notVerified = [];
  const markers = [];
  const mark = (m) => { if (!markers.includes(m)) markers.push(m); };
  for (const entry of value) {
    if (typeof entry !== "string") { mark("notVerifiedInvalid"); continue; }
    const text = entry.trim();
    if (text.length === 0) { mark("notVerifiedInvalid"); continue; }
    if (text.length > NOT_VERIFIED_MAX_CHARS) { mark("notVerifiedTooLong"); continue; }
    notVerified.push(text);
  }
  return { notVerified, markers };
}

export function evaluateEvidenceGate(checklist) {
  const entries = normalizeEvidenceChecklist(checklist);
  if (entries.length === 0) {
    return { ok: false, code: "evidence-no-evidence", reason: "delivery gate requires at least one evidence entry." };
  }
  const unmetIds = entries.filter((entry) => entry.status === "unmet").map((entry) => entry.id);
  if (unmetIds.length > 0) {
    return {
      ok: false,
      code: "evidence-unmet",
      reason: `delivery gate blocked by unmet evidence entries: ${unmetIds.join(", ")}.`,
      unmetIds,
      mainRerunPassCount: 0,
    };
  }
  const mainRerunPassCount = entries.filter(
    (entry) => entry.mainRerun !== null && entry.mainRerun.matches === true,
  ).length;
  if (mainRerunPassCount === 0) {
    return {
      ok: false,
      code: "evidence-main-rerun-missing",
      reason: "delivery gate requires at least one entry whose mainRerun.matches === true; self-attested entries alone cannot pass.",
      unmetIds: [],
      mainRerunPassCount: 0,
    };
  }
  return { ok: true, reason: "delivery gate passed.", unmetIds: [], mainRerunPassCount };
}

export function runMainRerunOnce({
  command,
  expected = "",
  cwd,
  timeoutMs = MAIN_RERUN_TIMEOUT_MS,
  tailCharLimit = MAIN_RERUN_TAIL_CHAR_LIMIT,
} = {}) {
  return new Promise((resolve) => {
    if (typeof command !== "string" || command.trim().length === 0) {
      resolve({ ok: false, code: "evidence-command-invalid", matches: false, actualTail: "", exitCode: null });
      return;
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MAIN_RERUN_TIMEOUT_MS;
    const tailLimit = Number.isFinite(tailCharLimit) && tailCharLimit > 0 ? tailCharLimit : MAIN_RERUN_TAIL_CHAR_LIMIT;
    exec(
      command,
      {
        cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const combined = [stdout, stderr]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n")
          .trim();
        const actualTail = combined.slice(-tailLimit);
        if (error === null || error === undefined) {
          const expectedTrim = typeof expected === "string" ? expected.trim() : "";
          const matchesExpected = expectedTrim.length === 0 || combined.includes(expectedTrim);
          resolve({
            ok: true,
            matches: matchesExpected,
            actualTail,
            exitCode: 0,
            ...(matchesExpected ? {} : { code: "evidence-expected-mismatch" }),
          });
          return;
        }
        const killed =
          error.killed === true ||
          (typeof error.message === "string" &&
            (error.message.includes("ETIMEDOUT") || error.message.includes("SIGTERM")));
        resolve({
          ok: false,
          code: killed ? "evidence-timeout" : "evidence-command-failed",
          matches: false,
          actualTail,
          exitCode: typeof error.code === "number" ? error.code : null,
          reason: typeof error.message === "string" ? error.message.slice(0, 500) : "command failed",
        });
      },
    );
  });
}
