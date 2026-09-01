#!/usr/bin/env node
// safe-json-write verification probe — self-contained, no external deps.
// Exit code 0 only when ALL checks pass.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveTarget,
  serializeJson,
  writeJsonSafe,
} from "./lib/core.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readBytes(file) {
  return new Uint8Array(fs.readFileSync(file));
}

function hasBom(file) {
  const bytes = readBytes(file);
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

check("core exports resolveTarget", () => {
  if (typeof resolveTarget !== "function") throw new Error("resolveTarget not exported");
});

check("core exports serializeJson", () => {
  if (typeof serializeJson !== "function") throw new Error("serializeJson not exported");
});

check("core exports writeJsonSafe", () => {
  if (typeof writeJsonSafe !== "function") throw new Error("writeJsonSafe not exported");
});

check("serializeJson has no BOM and trailing newline", () => {
  const text = serializeJson({ a: 1 }, 2);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("BOM present in text");
  if (!text.endsWith("\n")) throw new Error("missing trailing newline");
});

{
  const dir = makeTempDir("sjw-");
  try {
    const target = path.join(dir, "out.json");
    const data = { hello: "world", nested: { ok: true } };

    check("writes JSON without BOM bytes", () => {
      writeJsonSafe({ target, data, root: dir });
      if (!fs.existsSync(target)) throw new Error("target not created");
      if (hasBom(target)) throw new Error("target starts with UTF-8 BOM");
    });

    check("written JSON round-trips through JSON.parse", () => {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (JSON.stringify(parsed) !== JSON.stringify(data)) {
        throw new Error("round-trip mismatch");
      }
    });

    check("pretty-print indent applies", () => {
      const raw = fs.readFileSync(target, "utf8");
      if (!raw.includes('\n  "hello"')) throw new Error("expected 2-space indent");
    });

    check("relative target inside root is allowed", () => {
      const rel = path.join("sub", "nested.json");
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      const result = writeJsonSafe({ target: rel, data: { ok: true }, root: dir });
      if (!fs.existsSync(path.join(dir, rel))) throw new Error("relative target missing");
      if (result.target !== path.resolve(dir, rel)) throw new Error("unexpected resolved target");
    });

    check("absolute target outside root is rejected", () => {
      const outside = path.join(os.tmpdir(), `sjw-outside-${Date.now()}.json`);
      let threw = false;
      try {
        writeJsonSafe({ target: outside, data: { x: 1 }, root: dir });
      } catch (error) {
        threw = /OUT_OF_BOUNDS/.test(error.message);
      }
      if (!threw) throw new Error("expected OUT_OF_BOUNDS rejection");
    });

    check("relative .. escape is rejected", () => {
      let threw = false;
      try {
        writeJsonSafe({ target: path.join("..", "escape.json"), data: { x: 1 }, root: dir });
      } catch (error) {
        threw = /OUT_OF_BOUNDS/.test(error.message);
      }
      if (!threw) throw new Error("expected OUT_OF_BOUNDS rejection");
    });

    check("backup file is created before write", () => {
      const backupDir = path.join(dir, "backups");
      fs.writeFileSync(target, '{"old":true}\n', "utf8");
      const result = writeJsonSafe({
        target,
        data: { new: true },
        root: dir,
        backupDir,
      });
      if (!result.backup || !fs.existsSync(result.backup)) throw new Error("backup missing");
      const backupText = fs.readFileSync(result.backup, "utf8");
      if (backupText.trim() !== '{"old":true}') throw new Error("backup content mismatch");
    });

    check("rollback restores previous content on write failure", () => {
      const rollTarget = path.join(dir, "rollback.json");
      const oldContent = '{"previous":"value"}\n';
      fs.writeFileSync(rollTarget, oldContent, "utf8");
      let threw = false;
      try {
        writeJsonSafe(
          { target: rollTarget, data: { next: true }, root: dir },
          {
            writeFile(file, content, encoding) {
              if (String(file).includes(".tmp-")) {
                throw new Error("simulated write failure");
              }
              fs.writeFileSync(file, content, encoding);
            },
          },
        );
      } catch (error) {
        threw = true;
        if (error.rollbackError) throw new Error(`rollback itself failed: ${error.rollbackError}`);
      }
      if (!threw) throw new Error("expected simulated failure");
      const after = fs.readFileSync(rollTarget, "utf8");
      if (after !== oldContent) throw new Error("rollback did not restore old content");
    });

    check("backup failure aborts without mutating target", () => {
      const abortTarget = path.join(dir, "abort.json");
      fs.writeFileSync(abortTarget, '{"keep":true}\n', "utf8");
      let threw = false;
      try {
        writeJsonSafe(
          { target: abortTarget, data: { nope: true }, root: dir },
          {
            writeFile(file, content, encoding) {
              if (String(file).includes(".bak-")) {
                throw new Error("simulated backup failure");
              }
              fs.writeFileSync(file, content, encoding);
            },
          },
        );
      } catch (error) {
        threw = /BACKUP_FAILED/.test(error.message);
      }
      if (!threw) throw new Error("expected BACKUP_FAILED");
      const after = fs.readFileSync(abortTarget, "utf8");
      if (after.trim() !== '{"keep":true}') throw new Error("target was mutated on backup failure");
    });

    check("new file with no previous content writes cleanly", () => {
      const fresh = path.join(dir, "fresh.json");
      const result = writeJsonSafe({ target: fresh, data: [1, 2, 3], root: dir, space: 0 });
      if (result.backup !== null) throw new Error("unexpected backup for new file");
      if (JSON.parse(fs.readFileSync(fresh, "utf8")).length !== 3) throw new Error("array round-trip failed");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`probe-safe-json-write.mjs FAILED (${failed}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`probe-safe-json-write.mjs ALL PASS (${passed})`);
}
