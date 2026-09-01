#!/usr/bin/env node
// safe-json-write CLI
// ===========================================================================
// Usage:
//   node cli.mjs --input <json-file> --output <target> [--root <dir>] [--space N] [--backup-dir <dir>]
//   node cli.mjs --json '{"a":1}' --output <target> [same options]
//
// Direct-invocation detection uses basename(process.argv[1]) === "cli.mjs"
// because import.meta.url comparison is unreliable under junctions.
// ===========================================================================

import fs from "node:fs";
import path from "node:path";
import { writeJsonSafe } from "./lib/core.mjs";

const HELP = `safe-json-write CLI v0.1.0

Usage:
  node cli.mjs --input <file.json> --output <target.json> [options]
  node cli.mjs --json '<inline json>' --output <target.json> [options]

Options:
  --input <path>       Read JSON data from this file.
  --json <json>        Use inline JSON as data (alternative to --input).
  --output <path>      Target JSON file to write (required).
  --root <dir>         Confinement root; target must stay inside (default: cwd).
  --space <n>          Pretty-print indent spaces (default: 2).
  --backup-dir <dir>   Put backups in this directory (default: next to target).
  --help               Show this help.
  --version            Show version.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--version" || arg === "-v") args.version = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = value;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write("0.1.0\n");
    return;
  }

  if (!args.output) {
    process.stderr.write("safe-json-write: --output <target> is required\n");
    process.exitCode = 2;
    return;
  }

  let data;
  if (args.input) {
    const raw = fs.readFileSync(args.input, "utf8").replace(/^\uFEFF/, "");
    data = JSON.parse(raw);
  } else if (args.json !== undefined && args.json !== true) {
    data = JSON.parse(String(args.json).replace(/^\uFEFF/, ""));
  } else {
    process.stderr.write(
      "safe-json-write: either --input <file> or --json '<json>' is required\n",
    );
    process.exitCode = 2;
    return;
  }

  const space = args.space === undefined || args.space === true ? 2 : Number(args.space);
  const result = writeJsonSafe({
    target: args.output,
    data,
    root: args.root || process.cwd(),
    space: Number.isFinite(space) ? space : 2,
    backupDir: args["backup-dir"] || null,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "cli.mjs") {
  main();
}
