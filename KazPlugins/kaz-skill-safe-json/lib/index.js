// kaz-skill-safe-json —— safe_json_write tool
// ===========================================================================
// Registered ONLY through kaz/agent.cordis.yml (repo path is a junction to
// ~/.dsh/.agent-presets/kaz/agent.cordis.yml). Never added to web-level
// cordis.patch.yml. The tool honors skills/safe-json-write/switch.json as the
// skill-level enable/disable switch; the tool-surface visibility is controlled
// by the project four-file model + kaz_tool_auto_on.
// ===========================================================================

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeJsonSafe } from "../skills/safe-json-write/lib/core.mjs";

export const SAFE_JSON_WRITE_TOOL = "safe_json_write";

function switchPath() {
  return fileURLToPath(
    new URL("../skills/safe-json-write/switch.json", import.meta.url),
  );
}

function ensureEnabled() {
  try {
    const raw = fs.readFileSync(switchPath(), "utf8").replace(/^\uFEFF/, "");
    const state = JSON.parse(raw);
    if (state?.enabled !== true) {
      throw new Error(
        "SAFE_JSON_WRITE_DISABLED: switch.json enabled is not true",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SAFE_JSON_WRITE_DISABLED")) {
      throw error;
    }
    throw new Error(
      `SAFE_JSON_WRITE_SWITCH_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export default {
  name: "kaz-skill-safe-json",
  inject: ["tools"],
  apply(ctx, _config = {}) {
    const safeJsonWriteDef = defineTool({
      name: SAFE_JSON_WRITE_TOOL,
      description:
        "Safely write JSON data to a file: UTF-8 without BOM, out-of-bounds rejection against a root, backup of the previous file, and rollback on write failure.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Target JSON file path; must stay inside root.",
        },
        data: {
          type: "json",
          required: true,
          description: "JSON-serializable value to write.",
        },
        root: {
          type: "string",
          description:
            "Allowed root directory; target must stay inside it (default: workspace cwd).",
        },
        space: {
          type: "integer",
          description: "Pretty-print indent spaces (default: 2).",
        },
        backupDir: {
          type: "string",
          description: "Optional directory for the backup of the previous file.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            target: { type: "string", required: true },
            bytes: { type: "integer", required: true },
            backup: {
              oneOf: [{ type: "string" }, { type: "null" }],
              required: true,
            },
            rolledBack: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute(args, _exec) {
        try {
          ensureEnabled();
          const result = writeJsonSafe({
            target: args.target,
            data: args.data,
            root: args.root || process.cwd(),
            space: args.space ?? 2,
            backupDir: args.backupDir || null,
          });
          return Promise.resolve(result);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      presentCall: () => ({ card: "generic", title: "安全写入 JSON", kind: "other" }),
    });

    let disposed = false;
    const dispose = ctx.tools.register(safeJsonWriteDef);
    ctx.effect(() => () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose();
      } catch (error) {
        ctx.logger?.warn?.(
          `[kaz-skill-safe-json] 注销 ${SAFE_JSON_WRITE_TOOL} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  },
};
