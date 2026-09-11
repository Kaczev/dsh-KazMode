// ka-whale-workflow —— 7.4 P3 evidence/delivery gate（ESM + child_process）
// §3.4/§9.1: unmet blocks; ≥1 mainRerun.matches=true; runner single 120s, no retry.
// 7.4 shell parity: evidence reruns through the same shell family the model's
// pwsh tool uses (PowerShell 7 when installed, otherwise Windows PowerShell).
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { normalizeEvidenceChecklist } from "./intent-map.js";

export const MAIN_RERUN_TIMEOUT_MS = 120_000;
export const MAIN_RERUN_TAIL_CHAR_LIMIT = 4000;
export const NOT_VERIFIED_MAX_CHARS = 200;

/** Pure builder for the shell-service request. Mirrors dsh-tool-pwsh's
 *  conditional-field spread: only fields whose value is not undefined are
 *  included, so an absent service leaves the field out instead of passing null. */
export function buildEvidenceShellRequest({
  command,
  workdir,
  timeoutMs,
  dshEnv,
  sandboxPolicy,
} = {}) {
  const request = {};
  if (command !== undefined) request.command = command;
  if (workdir !== undefined) request.workdir = workdir;
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  if (dshEnv !== undefined) request.dshEnv = dshEnv;
  if (sandboxPolicy !== undefined) request.sandboxPolicy = sandboxPolicy;
  return request;
}

/** dsh-pwsh-local resolution order on win32: PowerShell 7 install, each PATH
 *  entry, then Windows PowerShell. Candidate must exist as a file or symlink. */
function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveEvidenceShellPath({
  env = process.env,
  platform = process.platform,
  configuredPath,
} = {}) {
  const configured =
    typeof configuredPath === "string" && configuredPath.trim().length > 0
      ? configuredPath.trim()
      : "";
  if (configured.length > 0) return configured;
  const e = env && typeof env === "object" ? env : {};
  if (platform === "win32") {
    const programFiles =
      typeof e.ProgramFiles === "string" && e.ProgramFiles.length > 0
        ? e.ProgramFiles
        : "C:\\Program Files";
    const systemRoot =
      typeof e.SystemRoot === "string" && e.SystemRoot.length > 0
        ? e.SystemRoot
        : "C:\\Windows";
    const candidates = [join(programFiles, "PowerShell", "7", "pwsh.exe")];
    const pathValue = typeof e.PATH === "string" ? e.PATH : "";
    for (const entry of pathValue.split(";")) {
      const trimmed = entry.trim().replace(/^"|"$/g, "");
      if (trimmed.length === 0) continue;
      candidates.push(join(trimmed, "pwsh.exe"));
    }
    candidates.push(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    for (const candidate of candidates) {
      if (candidateExists(candidate)) return candidate;
    }
    return "pwsh";
  }
  const shell =
    typeof e.SHELL === "string" && e.SHELL.trim().length > 0 ? e.SHELL.trim() : "/bin/sh";
  return shell;
}

/** Windows PowerShell 5.1 is the last-resort powershell.exe executable. */
export function isWindowsPowerShell51(shellPath) {
  if (typeof shellPath !== "string") return false;
  const normalized = shellPath.trim().toLowerCase().replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base === "powershell.exe" && !normalized.includes("pwsh.exe");
}

/** Detect && / || outside quoted regions and comments. PowerShell treats both
 *  quote kinds as literal regions; backtick escapes the next character. */
export function usesPipelineChainOperator(command) {
  if (typeof command !== "string") return false;
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "`" && i + 1 < command.length) {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "#") {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (ch === "`" && i + 1 < command.length) {
      i += 1;
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) return true;
  }
  return false;
}

function shellMismatchResult() {
  return {
    ok: false,
    code: "evidence-command-shell-mismatch",
    matches: false,
    actualTail: "",
    exitCode: null,
    reason:
      "evidence command uses '&&' or '||', which the rerun shell cannot parse; use ';' separators or one command per evidence entry.",
  };
}

function runLocalShell({ command, cwd, timeoutMs, shell, platform }) {
  return new Promise((resolve) => {
    const isWin = platform === "win32";
    const args = isWin
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];
    let child;
    try {
      child = spawn(shell, args, {
        cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        code: "evidence-command-failed",
        matches: false,
        actualTail: "",
        exitCode: null,
        stdout: { text: "" },
        stderr: { text: "" },
        reason: `failed to start shell: ${String(error?.message ?? error).slice(0, 300)}`,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // process may already have exited
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // best-effort second kill
        }
      }, 1000).unref();
    }, timeoutMs);
    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n").trim();
      finish({
        ok: false,
        code: timedOut ? "evidence-timeout" : "evidence-command-failed",
        matches: false,
        actualTail: combined.slice(-4000),
        exitCode: null,
        timedOut,
        stdout: { text: stdout },
        stderr: { text: stderr },
        reason: `failed to start shell: ${String(error?.message ?? error).slice(0, 300)}`,
      });
    });
    child.on("close", (code, _signal) => {
      const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n").trim();
      const actualTail = combined.slice(-4000);
      if (timedOut) {
        finish({
          ok: false,
          code: "evidence-timeout",
          matches: false,
          actualTail,
          exitCode: null,
          timedOut: true,
          stdout: { text: stdout },
          stderr: { text: stderr },
          reason: "evidence command timed out.",
        });
        return;
      }
      if (typeof code !== "number" || code !== 0) {
        finish({
          ok: false,
          code: "evidence-command-failed",
          matches: false,
          actualTail,
          exitCode: typeof code === "number" ? code : null,
          stdout: { text: stdout },
          stderr: { text: stderr },
          reason: `evidence command failed with exit code ${String(code)}.`,
        });
        return;
      }
      finish({ exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr }, timedOut: false });
    });
  });
}

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

export async function runMainRerunOnce({
  command,
  expected = "",
  cwd,
  timeoutMs = MAIN_RERUN_TIMEOUT_MS,
  tailCharLimit = MAIN_RERUN_TAIL_CHAR_LIMIT,
  runShell,
  shellPath,
  platform,
} = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, code: "evidence-command-invalid", matches: false, actualTail: "", exitCode: null };
  }
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MAIN_RERUN_TIMEOUT_MS;
  const tailLimit = Number.isFinite(tailCharLimit) && tailCharLimit > 0 ? tailCharLimit : MAIN_RERUN_TAIL_CHAR_LIMIT;
  const effectivePlatform = platform ?? process.platform;
  const effectiveShell =
    typeof shellPath === "string" && shellPath.trim().length > 0
      ? shellPath.trim()
      : resolveEvidenceShellPath({ env: process.env, platform: effectivePlatform });
  const hasChain = usesPipelineChainOperator(command);
  if (
    effectivePlatform === "win32" &&
    isWindowsPowerShell51(effectiveShell) &&
    hasChain
  ) {
    return shellMismatchResult();
  }

  let rawResult;
  if (typeof runShell === "function") {
    try {
      rawResult = await runShell({
        command,
        workdir: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
        timeoutMs: timeout,
      });
    } catch (error) {
      rawResult = {
        exitCode: null,
        stdout: { text: "" },
        stderr: {
          text: `evidence runner error: ${String(error?.message ?? error).slice(0, 300)}`,
        },
        timedOut: false,
      };
    }
  } else {
    rawResult = await runLocalShell({
      command,
      cwd,
      timeoutMs: timeout,
      shell: effectiveShell,
      platform: effectivePlatform,
    });
  }

  const stdoutText =
    typeof rawResult?.stdout?.text === "string" ? rawResult.stdout.text : "";
  const stderrText =
    typeof rawResult?.stderr?.text === "string" ? rawResult.stderr.text : "";
  const combined = [stdoutText, stderrText]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  const actualTail = combined.slice(-tailLimit);
  const parseError =
    /ParserError|not a valid statement separator/i.test(stderrText) ||
    /ParserError|not a valid statement separator/i.test(stdoutText);
  if (parseError && hasChain) {
    return shellMismatchResult();
  }
  if (rawResult?.timedOut === true) {
    return {
      ok: false,
      code: "evidence-timeout",
      matches: false,
      actualTail,
      exitCode: null,
      reason: "evidence command timed out.",
    };
  }
  const exitCode = typeof rawResult?.exitCode === "number" ? rawResult.exitCode : null;
  if (exitCode !== 0) {
    return {
      ok: false,
      code: "evidence-command-failed",
      matches: false,
      actualTail,
      exitCode,
      reason:
        typeof rawResult?.reason === "string" && rawResult.reason.length > 0
          ? rawResult.reason
          : exitCode === null
            ? "evidence command failed before exiting."
            : `evidence command failed with exit code ${exitCode}.`,
    };
  }
  const expectedTrim = typeof expected === "string" ? expected.trim() : "";
  const matchesExpected = expectedTrim.length === 0 || combined.includes(expectedTrim);
  return {
    ok: true,
    matches: matchesExpected,
    actualTail,
    exitCode: 0,
    ...(matchesExpected ? {} : { code: "evidence-expected-mismatch" }),
  };
}
