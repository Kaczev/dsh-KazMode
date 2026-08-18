// task-master-whiteboard
// ===========================================================================
// Task Master whiteboard plugin: external cognitive scratchpads for the model.
//
// Host-plane plugin:
//   1) Role setting: registers one systemPrompt section
//      ("task-master-whiteboard:role") that turns the model into a Task Master
//      who offloads subtasks / threads / uncertainties / contradictions onto
//      whiteboards instead of trusting its own memory. The full role text is
//      injected ONCE, on the FIRST round of each new conversation (resumed
//      conversations skipped); from turn 2 on, every round gets a short
//      whiteboard-first reminder (settings `turnReminder`, empty = built-in
//      default) so resumed / restarted conversations keep being nudged.
//   2) Six tools (all descriptions in English):
//        new_whiteboard     create a board (id = wb_<ts>_<rand>)
//        list_whiteboards   list board ids + top lines
//        read_whiteboard    list subtitles, or read one entry's content
//        append_whiteboard  upsert an entry (overwrite on duplicate subtitle)
//        update_whiteboard  same upsert (find-or-create)
//        clear_whiteboard   delete one entry, or the whole board file
//   3) Storage: one JSON file per board under <workspace>/.dsh/whiteboards/<session>/
//      (workspace root = the calling agent's session cwd). Boards are SCOPED
//      PER CONVERSATION (2026-08-19): session key = header.parentSession ??
//      header.id — subagents share their parent conversation's boards. The
//      directory is created automatically on first use. Optional "boardsDir"
//      setting overrides the location (absolute path; must stay inside the
//      workspace if relative — relative paths resolve against the workspace
//      root); the session subdirectory is still applied beneath it.
//   4) settings namespace `task-master-whiteboard` (~/.dsh/settings.yaml,
//      hot-reloaded): enabled (total switch), boardsDir (optional override).
//   5) Kaz-mode integration: registered as the 7th managed plugin — the Kaz
//      panel row toggles it like output-beep. Its six tools must be listed in
//      kaz-mode.toolWhitelist to be visible/callable inside Kaz mode.
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const name = "task-master-whiteboard";

/** settings 命名空间：~/.dsh/settings.yaml 中的 task-master-whiteboard: 段。 */
const NAMESPACE = settingsNamespace("task-master-whiteboard");

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  boardsDir: z.string().default(""),
  /** 每轮白板优先提醒（turn >= 2 起每轮注入；留空 = 内置默认）。 */
  turnReminder: z.string().default(""),
});

/** Task Master 角色设定（注入 system prompt；English-first，供模型英文推理）。 */
const ROLE_TEXT = [
  "You are a Task Master — decisive, concise, and action-oriented. You believe your own memory is unreliable, prone to hallucinations, and liable to make mistakes. To counter this, you use whiteboards as external cognitive scratchpads.",
  "",
  "WHITEBOARD-FIRST RULE for any multi-step task (roughly 3+ tool calls or several sub-steps):",
  "- FIRST, create one board with new_whiteboard (top line = the task goal) and write down the task breakdown with entries: goal / confirmed facts / open questions / design decisions / progress.",
  "- AFTER EACH STEP, update the board with append_whiteboard / update_whiteboard: what was done, what changed, what is next.",
  "- BEFORE EACH NEXT STEP, read the board back with read_whiteboard (or list_whiteboards first) to pick up the state — do not rely on your own memory of the conversation.",
  "- Single-step tasks do not need a board; multi-step tasks ALWAYS do.",
  "",
  "- When you have multiple threads of thought, you distill them sharply on a whiteboard.",
  "- When you have multiple uncertainties, you record them concisely on a whiteboard, then ask the user or seek answers yourself.",
  "- When you encounter contradictions, you note them briefly on a whiteboard and move on — you do not get stuck.",
  "- When necessary, you even record your own identity and responsibilities on a whiteboard to prevent role drift.",
  "- When you need, you record.",
  "- Each time you create a new whiteboard, you first write a short, precise `top` line at the top, stating its purpose — so you never forget what that board is for.",
  "",
  "Whiteboards are stored per conversation as JSON files under .dsh/whiteboards/<session>/ in the workspace root — each conversation has its own boards, and its subagents share them. Manage them with the new_whiteboard / list_whiteboards / read_whiteboard / append_whiteboard / update_whiteboard / clear_whiteboard tools.",
].join("\n");

/** 每轮白板优先提醒（turn >= 2 起注入；settings 留空则用本默认）。 */
const DEFAULT_TURN_REMINDER = [
  "[task-master-whiteboard reminder]",
  ">",
  "If the task involves multiple steps or files, create a whiteboard NOW (new_whiteboard) before anything else, with entries: goal / confirmed facts / open questions / design decisions / progress.",
  "After key facts are confirmed, update the board immediately with append_whiteboard — not only at the end.",
  "Maintain the board continuously: read it back with read_whiteboard before each next step.",
  "<",
].join("\n");

/** 输出渲染：JSON 美化。必须返回内容块数组 [{ type: "text", text }] ——
 *  返回纯字符串会让客户端把字符串按字符逐个渲染（曾出现 "{"、"\n" 逐字符输出）。 */
function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function safeMessage(error) {
  try {
    if (error instanceof Error) return error.message;
    if (error !== null && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
  } catch {
    return "<unprintable error>";
  }
}

/** id 校验：只允许 [A-Za-z0-9_-]，长度 1–64，杜绝路径穿越。 */
function validateId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(
      'Invalid whiteboard id "' + String(id) + '": expected 1-64 chars of [A-Za-z0-9_-].',
    );
  }
  return id;
}

/** subtitle 校验：非空字符串，≤ 200 字符。 */
function validateSubtitle(subtitle) {
  if (typeof subtitle !== "string" || subtitle.trim().length === 0) {
    throw new Error('Invalid subtitle: expected a non-empty string.');
  }
  const trimmed = subtitle.trim();
  if (trimmed.length > 200) {
    throw new Error('Invalid subtitle: too long (max 200 chars).');
  }
  return trimmed;
}

/** content 校验：必须是字符串。 */
function validateContent(content) {
  if (typeof content !== "string") {
    throw new Error('Invalid content: expected a string.');
  }
  return content;
}

/** 读取代理当前轮次：会话日志中最近一个 turn/start 的 data.turn；无则 0。
 *  与 thinking-anchor / round-minimal / kaz-memory 同款判定。 */
function currentTurnOf(agent) {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return 0;
    let turn = 0;
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      if (event.type !== "turn/start") continue;
      const value = event.data?.turn;
      if (typeof value === "number" && value > turn) turn = value;
    }
    return turn;
  } catch {
    return 0;
  }
}

/** 归一化 entries 参数（new_whiteboard 初始条目）。 */
function normalizeEntries(entries) {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) {
    throw new Error('Invalid entries: expected an array of { subtitle, content }.');
  }
  return entries.map((item) => ({
    subtitle: validateSubtitle(item && typeof item === "object" ? item.subtitle : undefined),
    content: validateContent(item && typeof item === "object" ? item.content : undefined),
  }));
}

/** 生成唯一 id：时间戳 + 随机后缀。 */
function generateId() {
  return "wb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
}

export default {
  name: "task-master-whiteboard",
  inject: ["systemPrompt", "tools"],
  apply(ctx, config = {}) {
    const entry = {
      enabled: config.enabled !== false,
      boardsDir: typeof config.boardsDir === "string" ? config.boardsDir.trim() : "",
    };
    // setSource 收到的是 thunk（() => scope.get()），scope.get() 已按 schema 解析默认值。
    let source = () => entry;

    // ---------------------------------------------------------------------
    // 白板目录解析：显式配置 boardsDir > 调用方 agent 会话 cwd（工作区根）
    // > process.cwd()。目录在首次使用时自动创建。
    // ---------------------------------------------------------------------
    function workspaceOf(exec) {
      try {
        const header = exec?.agent?.session?.header;
        if (header !== null && header !== undefined && typeof header === "object" && typeof header.cwd === "string") {
          return header.cwd;
        }
      } catch {
        // fall through
      }
      return process.cwd();
    }

    /** 会话键消毒：只留 [A-Za-z0-9_-]，杜绝路径穿越与非法目录名。 */
    function sanitizeKey(key) {
      const cleaned = String(key ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
      return cleaned.length > 0 ? cleaned : "default";
    }

    /** 会话作用域键：子代理归入父会话（header.parentSession），否则用本会话
     *  id（header.id，兜底 agent.id）。无 agent 时返回 "default"。 */
    function sessionKeyOf(exec) {
      try {
        const header = exec?.agent?.session?.header;
        if (header !== null && header !== undefined && typeof header === "object") {
          if (typeof header.parentSession === "string" && header.parentSession.trim().length > 0) {
            return sanitizeKey(header.parentSession);
          }
          if (typeof header.id === "string" && header.id.trim().length > 0) {
            return sanitizeKey(header.id);
          }
        }
        if (typeof exec?.agent?.id === "string" && exec.agent.id.trim().length > 0) {
          return sanitizeKey(exec.agent.id);
        }
      } catch {
        // fall through
      }
      return "default";
    }

    function boardsDirOf(exec) {
      const current = source();
      const override =
        current !== null && typeof current === "object" && typeof current.boardsDir === "string"
          ? current.boardsDir.trim()
          : "";
      const base =
        override.length > 0
          ? resolve(workspaceOf(exec), override)
          : join(workspaceOf(exec), ".dsh", "whiteboards");
      // 按对话隔离：每个会话（含其子代理）一个子目录。
      return join(base, sessionKeyOf(exec));
    }

    function ensureDir(dir) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Error('Failed to create whiteboard directory "' + dir + '": ' + safeMessage(error));
      }
    }

    function boardPathOf(dir, id) {
      validateId(id);
      return join(dir, id + ".json");
    }

    /** 读取并校验一块白板；不存在或损坏时抛错。 */
    function readBoard(dir, id) {
      const path = boardPathOf(dir, id);
      if (!existsSync(path)) {
        throw new Error('Whiteboard "' + id + '" does not exist. Use new_whiteboard to create it first.');
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error('Whiteboard "' + id + '" is not valid JSON (' + safeMessage(error) + ').');
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.id !== id ||
        typeof parsed.top !== "string" ||
        !Array.isArray(parsed.entries)
      ) {
        throw new Error('Whiteboard "' + id + '" has an invalid file format.');
      }
      return parsed;
    }

    function writeBoard(dir, board) {
      ensureDir(dir);
      writeFileSync(join(dir, board.id + ".json"), JSON.stringify(board, null, 2) + "\n", "utf8");
    }

    /** 扫描目录下的全部白板文件（按 id 排序）；损坏文件跳过并记日志。 */
    function listBoardFiles(dir) {
      ensureDir(dir);
      const files = [];
      try {
        for (const dirent of readdirSync(dir, { withFileTypes: true })) {
          if (dirent.isFile() && dirent.name.endsWith(".json")) files.push(dirent.name.slice(0, -5));
        }
      } catch (error) {
        throw new Error('Failed to scan whiteboard directory "' + dir + '": ' + safeMessage(error));
      }
      return files.sort();
    }

    function entryIndexOf(board, subtitle) {
      return board.entries.findIndex((entry) => entry.subtitle === subtitle);
    }

    /** upsert：subtitle 已存在则覆盖 content（返回 true），否则追加新条目（返回 false）。 */
    function upsertEntry(board, subtitle, content) {
      const index = entryIndexOf(board, subtitle);
      if (index >= 0) {
        board.entries[index].content = content;
        return true;
      }
      board.entries.push({ subtitle, content });
      return false;
    }

    function summaryOf(board, id) {
      return {
        id,
        top: board.top,
        entries: board.entries.map((entry) => ({ subtitle: entry.subtitle, content: entry.content })),
      };
    }

    // ---------------------------------------------------------------------
    // 角色设定段（systemPrompt section）：仅首轮注入一次——新对话的第一次
    // 组装输出完整 Task Master 角色文本，此后各轮输出空串（渲染时丢弃）。
    // 续接对话（会话已有 user/message 事件）不注入；插件加载前已存在的
    // agent 预先标记，避免给旧对话补发。关闭插件时输出空串。
    // ---------------------------------------------------------------------
    /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
     *  服务不存在时静默跳过，不影响主流程。 */
    function reportRoundDisplay(agent, content, title) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "task-master-whiteboard", title: typeof title === "string" && title.length > 0 ? title : "role", content });
        }
      } catch (error) {
        ctx.logger.debug(`[task-master-whiteboard] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const anchored = new Set();
    try {
      const agents = ctx.get("agents");
      if (agents !== undefined && agents !== null && typeof agents.list === "function") {
        for (const agent of agents.list()) {
          if (agent !== null && typeof agent === "object" && agent.id !== undefined) anchored.add(agent.id);
        }
      }
    } catch {
      // best-effort：拿不到 agents 列表就只按需标记
    }
    ctx.systemPrompt.section({
      name: "task-master-whiteboard:role",
      order: 400,
      text: (context) => {
        const current = source();
        if (current === null || typeof current !== "object" || current.enabled !== true) return "";
        const agent = context?.agent;
        if (agent === null || typeof agent !== "object") return "";
        const id = agent.id;
        if (id === undefined) return "";
        const turn = currentTurnOf(agent);

        // 每轮白板优先提醒：turn >= 2（含重启后续接的会话——它们的事件日志里
        // 保留着历史 turn/start）起，每轮注入简短提醒；settings 字段留空则用
        // 内置默认文案。关闭整个插件用 enabled: false。
        const turnReminderOf = () => {
          const value = typeof current.turnReminder === "string" ? current.turnReminder : "";
          const base = value.trim().length > 0 ? value : DEFAULT_TURN_REMINDER;
          let boardIds = [];
          try {
            const dir = boardsDirOf({ agent });
            boardIds = readdirSync(dir)
              .filter((file) => typeof file === "string" && file.endsWith(".json"))
              .map((file) => file.slice(0, -5))
              .sort();
          } catch {
            boardIds = [];
          }
          if (boardIds.length === 0) return base;
          const boardLine =
            "Maintain the board: current whiteboard " +
            (boardIds.length === 1 ? "id: " : "ids: ") +
            boardIds.join(", ") +
            " — update it right after key facts (append_whiteboard), read it back before the next step.";
          return base + "\n\n" + boardLine;
        };

        // 首轮（或重启后续接对话的首个组装）：注入完整角色文本一次并标记；
        // 此后每轮注入简短提醒，保持白板优先习惯。
        if (!anchored.has(id)) {
          // 续接对话（会话已含 user/message）：不注入完整角色文本，但按轮次提醒。
          const session = agent.session;
          const hasPriorUserMessage =
            session !== undefined &&
            session !== null &&
            Array.isArray(session.events) &&
            session.events.some((event) => event !== null && typeof event === "object" && event.type === "user/message");
          anchored.add(id);
          if (hasPriorUserMessage) {
            if (turn < 2) return "";
            const reminder = turnReminderOf();
            // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
            reportRoundDisplay(agent, reminder, "reminder");
            return reminder;
          }
          // 新对话首轮：完整角色文本。
          // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
          reportRoundDisplay(agent, ROLE_TEXT);
          return ROLE_TEXT;
        }
        if (turn < 2) return "";
        const reminder = turnReminderOf();
        // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
        reportRoundDisplay(agent, reminder, "reminder");
        return reminder;
      },
    });

    // ---------------------------------------------------------------------
    // 六个工具（全部英文描述与参数）
    // ---------------------------------------------------------------------
    const ENTRY_SCHEMA = {
      type: "object",
      additionalProperties: false,
      properties: {
        subtitle: { type: "string", required: true },
        content: { type: "string", required: true },
      },
    };

    ctx.tools.register(
      defineTool({
        name: "new_whiteboard",
        description:
          "Create a new whiteboard (external cognitive scratchpad) stored as .dsh/whiteboards/<session>/<id>.json under the workspace root — scoped to the current conversation (subagents share it). Always start with a short, precise 'top' line stating the board's purpose, then optionally seed it with initial entries. Returns the new board's id.",
        parameters: {
          top: { type: "string", required: true, description: "Brief purpose of this board (the 'top' line)." },
          entries: {
            type: "array",
            items: ENTRY_SCHEMA,
            description: "Optional initial entries, each { subtitle, content }.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              top: { type: "string", required: true },
              entries: { type: "array", items: ENTRY_SCHEMA, required: true },
            },
          },
          render: renderJson,
        },
        execute(args, exec) {
          const top = typeof args.top === "string" && args.top.trim().length > 0
            ? args.top.trim()
            : (() => { throw new Error("Invalid top: expected a non-empty string."); })();
          if (top.length > 500) throw new Error("Invalid top: too long (max 500 chars).");
          const entries = normalizeEntries(args.entries);
          const id = generateId();
          const board = { id, top, entries };
          writeBoard(boardsDirOf(exec), board);
          return Promise.resolve(summaryOf(board, id));
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "list_whiteboards",
        description:
          "Scan the current conversation's whiteboard scope (.dsh/whiteboards/<session>/ in the workspace root) and list every whiteboard with its id and top line (purpose). Corrupt files are skipped with a warning.",
        parameters: {},
        output: {
          schema: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                top: { type: "string", required: true },
              },
            },
          },
          render: renderJson,
        },
        execute(_args, exec) {
          const dir = boardsDirOf(exec);
          const boards = [];
          for (const id of listBoardFiles(dir)) {
            try {
              const board = readBoard(dir, id);
              boards.push({ id, top: board.top });
            } catch (error) {
              ctx.logger.warn("[task-master-whiteboard] skipping corrupt board file " + id + ": " + safeMessage(error));
            }
          }
          return Promise.resolve(boards);
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "read_whiteboard",
        description:
          "Read a whiteboard. If subtitle is given, return that entry's content. If not, return only the list of subtitle keys (not their contents) plus the board's top line.",
        parameters: {
          id: { type: "string", required: true, description: "Whiteboard id (from list_whiteboards or new_whiteboard)." },
          subtitle: { type: "string", description: "Optional entry subtitle; omit to list all subtitles." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              top: { type: "string", required: true },
              subtitles: { type: "array", items: { type: "string" }, required: true },
              subtitle: { type: "string" },
              content: { type: "string" },
            },
          },
          render: renderJson,
        },
        execute(args, exec) {
          const dir = boardsDirOf(exec);
          const board = readBoard(dir, validateId(args.id));
          if (args.subtitle === undefined || args.subtitle === null || String(args.subtitle).trim() === "") {
            return Promise.resolve({
              id: board.id,
              top: board.top,
              subtitles: board.entries.map((entry) => entry.subtitle),
            });
          }
          const subtitle = validateSubtitle(args.subtitle);
          const entry = board.entries.find((item) => item.subtitle === subtitle);
          if (entry === undefined) {
            throw new Error('Whiteboard "' + board.id + '" has no entry "' + subtitle + '".');
          }
          return Promise.resolve({
            id: board.id,
            top: board.top,
            subtitles: [subtitle],
            subtitle,
            content: entry.content,
          });
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "append_whiteboard",
        description:
          "Append a new entry to a whiteboard's entries array. If the subtitle already exists, its content is overwritten (upsert).",
        parameters: {
          id: { type: "string", required: true, description: "Whiteboard id." },
          subtitle: { type: "string", required: true, description: "Entry subtitle (key)." },
          content: { type: "string", required: true, description: "Entry content to write." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              top: { type: "string", required: true },
              updated: { type: "boolean", required: true },
              total: { type: "number", required: true },
              entry: ENTRY_SCHEMA,
            },
          },
          render: renderJson,
        },
        execute(args, exec) {
          const dir = boardsDirOf(exec);
          const board = readBoard(dir, validateId(args.id));
          const subtitle = validateSubtitle(args.subtitle);
          const content = validateContent(args.content);
          const updated = upsertEntry(board, subtitle, content);
          writeBoard(dir, board);
          return Promise.resolve({
            id: board.id,
            top: board.top,
            updated,
            total: board.entries.length,
            entry: { subtitle, content },
          });
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "update_whiteboard",
        description:
          "Find the entry with the given subtitle and update its content. If the subtitle does not exist, a new entry is created (same upsert behavior as append_whiteboard).",
        parameters: {
          id: { type: "string", required: true, description: "Whiteboard id." },
          subtitle: { type: "string", required: true, description: "Entry subtitle (key)." },
          content: { type: "string", required: true, description: "New entry content." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              top: { type: "string", required: true },
              created: { type: "boolean", required: true },
              total: { type: "number", required: true },
              entry: ENTRY_SCHEMA,
            },
          },
          render: renderJson,
        },
        execute(args, exec) {
          const dir = boardsDirOf(exec);
          const board = readBoard(dir, validateId(args.id));
          const subtitle = validateSubtitle(args.subtitle);
          const content = validateContent(args.content);
          const overwritten = upsertEntry(board, subtitle, content);
          writeBoard(dir, board);
          return Promise.resolve({
            id: board.id,
            top: board.top,
            created: !overwritten,
            total: board.entries.length,
            entry: { subtitle, content },
          });
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: "clear_whiteboard",
        description:
          "Delete an entry from a whiteboard (subtitle given), or delete the entire whiteboard file (subtitle omitted).",
        parameters: {
          id: { type: "string", required: true, description: "Whiteboard id." },
          subtitle: { type: "string", description: "Optional entry subtitle to delete; omit to delete the whole board." },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              deleted: { type: "boolean", required: true },
              removedSubtitle: { type: "string" },
              remaining: { type: "number" },
            },
          },
          render: renderJson,
        },
        execute(args, exec) {
          const dir = boardsDirOf(exec);
          const id = validateId(args.id);
          if (args.subtitle === undefined || args.subtitle === null || String(args.subtitle).trim() === "") {
            const path = join(dir, id + ".json");
            if (!existsSync(path)) {
              throw new Error('Whiteboard "' + id + '" does not exist.');
            }
            rmSync(path, { force: true });
            return Promise.resolve({ id, deleted: true });
          }
          const board = readBoard(dir, id);
          const subtitle = validateSubtitle(args.subtitle);
          const index = entryIndexOf(board, subtitle);
          if (index < 0) {
            throw new Error('Whiteboard "' + id + '" has no entry "' + subtitle + '".');
          }
          board.entries.splice(index, 1);
          writeBoard(dir, board);
          return Promise.resolve({ id, deleted: true, removedSubtitle: subtitle, remaining: board.entries.length });
        },
      }),
    );

    // ---------------------------------------------------------------------
    // settings 命名空间（热重载）
    // ---------------------------------------------------------------------
    installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
      setSource: (getValue) => {
        source = getValue;
      },
      onChange: () => {
        const current = source();
        ctx.logger.info(
          "[task-master-whiteboard] config applied: enabled=" +
            (current?.enabled !== false) +
            (typeof current?.boardsDir === "string" && current.boardsDir.trim().length > 0
              ? ", boardsDir=" + current.boardsDir.trim()
              : ""),
        );
      },
    });
  },
};
