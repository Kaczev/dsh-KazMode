// kaz-memory —— 独立记忆插件（自动载入 + RPC 面板通道）
// ===========================================================================
// 与 @max-null/dsh-memory 同功能的跨会话明文记忆：
//   * ctx.memory 引擎 + memory_save / memory_list / memory_search / memory_forget
//     四工具（引擎 vendored 自 @max-null/dsh-memory，MIT，存储位置与格式不变）
//   * 每条记忆 JSON 里持久化 name（保存/确认时自动从正文生成，面板可改名）
//   * tool:memory 固定指引在首轮工具调用之后以上下文消息注入一次；已确认且
//     标记「自动载入」（autoLoad）的记忆会在对话开始时（首个 pre-step）以上下文
//     注入方式注入一次（2026-08 重构：不再等 memory_search 首次可用）
//   * memory_list 只返回 id/namespace/status/autoLoad/名称，不返回正文与
//     keywords——避免列表调用把记忆灌进上下文；memory_search 才返回全文。
//   * 项目记忆按项目文件夹隔离（2026-08-17）：project 记忆写在
//     <项目文件夹>/.dsh/storages/memory_project.json，项目根从 agent 会话 cwd
//     （exec.agent.session.header.cwd）解析——不再用 dsh 进程的 process.cwd()。
//   * 面板数据通道 = 专用 Connection RPC（/kaz-memory，loopback）：list / open /
//     rename / status / autoLoad / forget / openFolder。记忆数据（含 name）全部
//     存在 JSON 文件里，settings.yaml 不再承载任何记忆存储信息（2026-08-19）。
//   * 人工确认闸门：模型 memory_save 只能写 suggested，只有人在面板确认才置为
//     auto；模型没有任何对应工具，闸门成立。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { MemoryEngine } from "./engine.js";

export { MemoryEngine, MemoryId } from "./engine.js";
export { bm25Scores, tokenize } from "./bm25.js";

export const name = "kaz-memory";
export const inject = ["storage", "systemPrompt", "tools", "connection"];

/** 设置命名空间：~/.dsh/settings.yaml 中的 kaz-memory: 段（面板桥接镜像）。 */
const NAMESPACE = settingsNamespace("kaz-memory");

const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    namespace: { type: "string", required: true, enum: ["global", "project"] },
    status: { type: "string", required: true, enum: ["suggested", "auto", "suggest"] },
    autoLoad: { type: "boolean", required: true },
    name: { type: "string", required: true },
    content: { type: "string", required: true },
    keywords: { type: "array", required: true, items: { type: "string" } },
    createdAt: { type: "number", required: true },
    updatedAt: { type: "number", required: true },
  },
};

const HIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    record: { ...RECORD_SCHEMA, required: true },
    score: { type: "number", required: true },
  },
};

/** memory_list 的返回项：只给 id / namespace / status / 名称，不含正文与 keywords。 */
const LIST_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    namespace: { type: "string", required: true, enum: ["global", "project"] },
    status: { type: "string", required: true, enum: ["suggested", "auto", "suggest"] },
    autoLoad: { type: "boolean", required: true },
    name: { type: "string", required: true },
  },
};

/** 取记忆名称：优先标题行（# 开头），否则首非空行；超长截断。 */
function nameOf(content, max = 140) {
  if (typeof content !== "string") return "";
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const title = lines.find((line) => line.startsWith("#"));
  const head = (title ?? lines[0]).replace(/^#+\s*/, "").trim();
  return head.length > max ? head.slice(0, max) + "…" : head;
}

function recordValue(record) {
  return {
    id: String(record.id),
    namespace: record.namespace,
    status: record.status,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
    autoLoad: record.autoLoad === true,
    content: record.content,
    keywords: record.keywords,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** memory_list 项：只给名称，不给正文。 */
function nameValue(record) {
  return {
    id: String(record.id),
    namespace: record.namespace,
    status: record.status,
    autoLoad: record.autoLoad === true,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
  };
}

/** 面板列表项：memory_list 字段 + 时间戳 + 所属项目路径（仅 project 记忆）。 */
function metaValue(record) {
  return {
    ...nameValue(record),
    autoLoad: record.autoLoad === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    project: record.namespace === "project" && typeof record.projectRoot === "string" ? record.projectRoot : "",
  };
}

function hitValue(hit) {
  return { record: recordValue(hit.record), score: hit.score };
}

function renderJson(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

function present(title, kind, rawInput) {
  return { card: "generic", title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}

/** 指引总述行（S 信息）：memory_search 可调用时作为指引第一行。
 *  2026-08-21：改为主动行动式措辞——模型应当主动查记忆、主动存记忆，
 *  而不是等到"遇到难题"才想起记忆。 */
const GUIDANCE_HEAD =
  "We need to search the memory (memory_search) at the start of a task for relevant information, and we need to save important facts we learn (memory_save) — the memory is shared with the user and persists across conversations.";

/** 判断某个记忆工具当前是否可用：
 *  1) 注册检查：plugin-filter / 组合移除会让工具不在注册表（工具面过滤后也不可见）；
 *  2) Kaz 工具面检查：kaz-mode.enabled=true 时，工具必须在 minimalTools +
 *     toolWhitelist 里才可见（组装层会过滤掉白名单外工具）。
 *  读不到的服务 / 设置一律按"不受限制"处理。 */
function toolAvailable(name, grouping, kazSettings) {
  const groupingOk = grouping !== undefined && grouping !== null && typeof grouping.isRegistered === "function";
  if (groupingOk && grouping.isRegistered(name) !== true) return false;
  if (kazSettings !== undefined && kazSettings !== null && typeof kazSettings === "object" && kazSettings.enabled === true) {
    const minimal = Array.isArray(kazSettings.minimalTools) ? kazSettings.minimalTools : ["pwsh", "str_replace_editor"];
    const whitelist = Array.isArray(kazSettings.toolWhitelist) ? kazSettings.toolWhitelist : [];
    if (!minimal.includes(name) && !whitelist.includes(name)) {
      const viaGroup =
        whitelist.includes("kaz-memory") &&
        groupingOk &&
        typeof grouping.groupOf === "function" &&
        grouping.groupOf(name) !== null &&
        grouping.groupOf(name).groupId === "kaz-memory";
      if (!viaGroup) return false;
    }
  }
  return true;
}

/**
 * 判断 memory_search 在当前代理环境是否真的可调用：
 *   1) 注册 + Kaz 工具面检查（toolAvailable）——不在注册表 / 不在 Kaz
 *      白名单即视为不可用；
 *   2) 首轮极简（round-minimal isMinimal）——执行层拒绝 memory_search，
 *      即使 schemas 里有也不能调用（与自动载入的 turn>1 兜底同一语义）；
 *   3) schemas(agent) 实际包含 memory_search——原生模式即直接工具面；
 *      Code Mode 下 wire 折叠为 run_code，schemas(agent) 返回的正是
 *      run_code SDK 可绑定的全部可见工具（含 memory_search），因此
 *      "在 schemas 里" 即代表"当前环境能经 run_code 调用"。
 *  读不到的服务 / 设置一律按"不受限制"处理；判定失败按"不可用"处理。
 */
function memorySearchCallable(agent, grouping, kazSettings, toolsSvc, roundMinimalSvc) {
  if (!toolAvailable("memory_search", grouping, kazSettings)) return false;
  if (roundMinimalSvc !== undefined && roundMinimalSvc !== null && typeof roundMinimalSvc.isMinimal === "function") {
    try {
      if (roundMinimalSvc.isMinimal(agent) === true) return false;
    } catch {
      // 判定失败不阻断，交给 schemas 检查兜底
    }
  }
  try {
    const schemas =
      toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.schemas === "function"
        ? toolsSvc.schemas(agent)
        : [];
    return (
      Array.isArray(schemas) &&
      schemas.some((schema) => schema !== null && typeof schema === "object" && schema.name === "memory_search")
    );
  } catch {
    return false;
  }
}

/**
 * 拼装首轮工具调用后注入的 [kaz-memory guidance] 上下文消息：
 *  统一消息格式 [标题] / > / 内容 / <；只发总述行（S）——记忆工具的具体
 *  用法由各工具描述自带，不再逐行重复 A/B/C/D。仅当 memory_search 在当前
 *  环境确实可调用（存在且可直接使用或经 run_code SDK 调用）时发送；
 *  memory_search 不可用时返回空串（不向模型发指引——没有检索能力的指引
 *  只会干扰模型思考）。
 *
 *  overrides.head：总述行覆盖（空 = 内置默认）。
 */
function composeGuidance(grouping, kazSettings, overrides = {}, agent, toolsSvc, roundMinimalSvc) {
  const head =
    overrides !== null &&
    typeof overrides === "object" &&
    typeof overrides.head === "string" &&
    overrides.head.trim().length > 0
      ? overrides.head.trim()
      : GUIDANCE_HEAD;
  if (!memorySearchCallable(agent, grouping, kazSettings, toolsSvc, roundMinimalSvc)) return "";
  return ["[kaz-memory guidance]", ">", head, "<"].join("\n");
}
const SETTINGS_SCHEMA = z.object({
  /** 总开关（Kaz 模式面板提供开关）：关闭时完全不注入记忆指引、不自动载入，
   *  客户端也不渲染记忆面板（sidebar 按钮与面板整体隐藏）。 */
  enabled: z.boolean().default(true),
  /** 整段指引覆盖（旧字段，保留兼容）：非空时完全取代动态拼装。 */
  guidance: z.string().default(""),
  /** 固定提示总述行覆盖：留空 = 内置默认。 */
  guidanceHead: z.string().default(""),
  /** 以下四个字段保留兼容（2026-08-17 起不再生效）：工具细节已并入各工具描述。 */
  guidanceSearch: z.string().default(""),
  guidanceSave: z.string().default(""),
  guidanceList: z.string().default(""),
  guidanceForget: z.string().default(""),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  guidance: "",
  enabled: true,
};
// ---------------------------------------------------------------------------
// settings 自愈：settings.yaml 中本插件段缺失时自动补齐默认值。
// 只写"缺失的键"，保留用户已有配置；settings.yaml 文件不存在时由 settings
// 服务在首次写入时自动创建（DSH_HOME 下的 settings.yaml）。
// ---------------------------------------------------------------------------

/** 卸载判定：插件 fiber 正在拆除时不再回写 source（与 dsh-settings 内部一致）。 */
function isUnloading(ctx) {
  const state = ctx.fiber.state;
  return state === 5 || state === 4; // FiberState.Unloading / Disposed
}

/**
 * 注册 settings 命名空间（语义与 installSettingsSection 相同：composition entry
 * 作 base、用户层优先、热重载），并在用户段缺失时只写缺失的键补齐默认值。
 */
function installSettingsWithDefaults(ctx, ns, schema, entry, defaults, hooks) {
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry });
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
    // 自愈：只补缺失键，保留用户已有配置（best-effort，失败只记日志）。
    ensureSettingsDefaults(sctx.settings, ns, defaults, ctx.logger);
  });
}

/**
 * 检查 settings.yaml 用户段：缺失的默认键用默认值补齐（合并写入，保留已有键）。
 * 返回写入的 patch；无需写入或失败时返回 null。独立导出便于测试。
 */
export function ensureSettingsDefaults(settings, ns, defaults, logger) {
  try {
    const descriptor = settings.describe().find((item) => item.ns === ns);
    const user =
      descriptor !== undefined && descriptor.user !== null && typeof descriptor.user === "object"
        ? descriptor.user
        : {};
    const patch = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (!Object.prototype.hasOwnProperty.call(user, key)) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return null;
    const write = settings.update(ns, patch);
    if (write !== null && typeof write.then === "function") {
      void write.then(
        () => {
          logger?.info?.("[ns] settings.yaml config section auto-filled missing keys: " + Object.keys(patch).join(", "));
        },
        (error) => {
          logger?.warn?.("[ns] auto-fill defaults failed: " + (error instanceof Error ? error.message : String(error)));
        },
      );
    }
    return patch;
  } catch (error) {
    logger?.warn?.("[ns] check defaults failed: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}


export async function apply(ctx, config = {}) {
  await ctx.plugin(MemoryEngine, config);
  const memory = ctx.get("memory");
  if (memory === undefined) throw new Error("memory engine failed to register");

  // ---- 设置（仅 guidance 配置；记忆数据不走 settings） ----
  // settings 服务惰性获取：apply 阶段可能尚未挂载（启动竞态），所有读写都在
  // 调用时解析；installSettingsSection 内部用 inject 等待服务，注册不受影响。
  const getSettings = () => ctx.get("settings");
  let source = () => ({
    enabled: true,
    guidance: "",
    guidanceHead: "",
    guidanceSearch: "",
    guidanceSave: "",
    guidanceList: "",
    guidanceForget: "",
  });

  // ---- 项目根解析 ----
  // 项目记忆归属「项目文件夹」：优先显式配置 projectRoot，其次当前工具调用
  // 的 agent 会话 cwd（exec.agent.session.header.cwd）；agent 缺失时兜底
  // process.cwd()（仅工具路径；镜像不用——见 currentProjectRoot 的注释）。
  function cwdOf(agent) {
    return agent &&
      agent.session &&
      agent.session.header &&
      typeof agent.session.header.cwd === "string"
      ? agent.session.header.cwd
      : undefined;
  }
  function projectRootOf(exec) {
    if (typeof config.projectRoot === "string" && config.projectRoot.length > 0) return config.projectRoot;
    return cwdOf(exec && exec.agent) ?? process.cwd();
  }
  /** 当前项目根（RPC 兜底用）：配置 > 最近创建/恢复的会话 cwd > 最后已知项目根 >
   *  undefined（绝不退回 process.cwd()）。面板经 RPC 显式上报当前会话 cwd，
   *  这里只是无上报时的兜底推断。 */
  let lastProjectRoot;
  function currentProjectRoot() {
    if (typeof config.projectRoot === "string" && config.projectRoot.length > 0) return config.projectRoot;
    try {
      const agents = ctx.get("agents");
      if (agents !== null && agents !== undefined) {
        let candidates = [];
        if (typeof agents.roots === "function") {
          const roots = agents.roots();
          if (Array.isArray(roots) && roots.length > 0) candidates = roots;
        }
        if (candidates.length === 0 && typeof agents.list === "function") {
          const all = agents.list();
          if (Array.isArray(all)) candidates = all;
        }
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const cwd = cwdOf(candidates[index]);
          if (cwd !== undefined) {
            lastProjectRoot = cwd;
            return cwd;
          }
        }
        if (typeof agents.currentInitiator === "function") {
          const cwd = cwdOf(agents.currentInitiator());
          if (cwd !== undefined) {
            lastProjectRoot = cwd;
            return cwd;
          }
        }
      }
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 解析当前项目根失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return lastProjectRoot;
  }

  // ---- 自动载入 + 固定指引：已注入标记持久化 ----
  // 2026-08-19 修复（Kaczev 报告）：autoLoadInjected 是进程内 WeakMap，dsh 重启
  // 后清空，恢复的会话会把 memory_search 误判为「首次可用」而重复注入。修复：
  // 把已注入的 agent id 持久化到 <DSH_HOME>/storages/kaz-memory-auto-injected.json
  // （默认 ~/.dsh/storages；config.autoInjectedStore 可覆盖，探针用临时文件），
  // 重启后同一会话不再注入。仅在实际注入成功后才落标。
  // 2026-08-21 扩展：固定指引（[kaz-memory guidance]）的 guidanceInjected 同样
  // 是进程内 WeakMap，重启后也会重复注入；这里把两种注入标记一起持久化。
  const AUTO_INJECTED_STORE =
    typeof config.autoInjectedStore === "string" && config.autoInjectedStore.trim().length > 0
      ? config.autoInjectedStore.trim()
      : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "kaz-memory-auto-injected.json");
  const persistedInjected = new Set();
  const persistedGuidanceInjected = new Set();
  try {
    if (existsSync(AUTO_INJECTED_STORE)) {
      // 兼容手工编辑/工具写入时可能带上的 UTF-8 BOM（﻿）
      const raw = readFileSync(AUTO_INJECTED_STORE, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.agents)) {
        for (const id of parsed.agents) {
          if (typeof id === "string" && id.length > 0) persistedInjected.add(id);
        }
      } else if (parsed !== null && typeof parsed === "object" && typeof parsed.agents === "string" && parsed.agents.length > 0) {
        // 兼容 PowerShell ConvertTo-Json 单元素数组被解包成字符串的写法
        persistedInjected.add(parsed.agents);
      }
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.guidanceAgents)) {
        for (const id of parsed.guidanceAgents) {
          if (typeof id === "string" && id.length > 0) persistedGuidanceInjected.add(id);
        }
      } else if (parsed !== null && typeof parsed === "object" && typeof parsed.guidanceAgents === "string" && parsed.guidanceAgents.length > 0) {
        // 兼容 PowerShell ConvertTo-Json 单元素数组被解包成字符串的写法
        persistedGuidanceInjected.add(parsed.guidanceAgents);
      }
    }
  } catch (error) {
    ctx.logger.warn(`[kaz-memory] 读取注入标记失败：${error instanceof Error ? error.message : String(error)}`);
  }
  function persistInjected() {
    try {
      mkdirSync(dirname(AUTO_INJECTED_STORE), { recursive: true });
      writeFileSync(
        AUTO_INJECTED_STORE,
        JSON.stringify(
          {
            agents: [...persistedInjected].sort(),
            guidanceAgents: [...persistedGuidanceInjected].sort(),
            updatedAt: Date.now(),
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 持久化注入标记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const autoLoadInjected = new WeakMap();
  const guidanceInjected = new WeakMap();

  // 加载时预标记现有 agent（thinking-anchor 同款）：自动载入和固定指引都视为
  // 已注入。重启后恢复的会话即使不在持久化标记里（例如标记文件晚于会话创建、
  // 或 id 格式差异），也不会被重复注入；持久化标记继续兜底「重启后晚于插件
  // 加载才恢复的会话」。
  try {
    const agents = ctx.get("agents");
    if (agents !== undefined && agents !== null && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        if (agent !== null && typeof agent === "object" && agent.id !== undefined) {
          autoLoadInjected.set(agent, true);
          guidanceInjected.set(agent, true);
          persistedInjected.add(String(agent.id));
          persistedGuidanceInjected.add(String(agent.id));
        }
      }
      persistInjected();
    }
  } catch (error) {
    ctx.logger.debug(`[kaz-memory] 预标记现有 agent 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  async function buildAutoLoadMessage(agent) {
    let records;
    try {
      records = await memory.list({
        status: "auto",
        autoLoad: true,
        projectRoot: projectRootOf({ agent }),
      });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 加载自动载入记忆失败: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (!Array.isArray(records) || records.length === 0) return undefined;
    const lines = ["[kaz-memory Auto-Load]", ">", "We need to recall the memories:"];
    for (const record of records) {
      const title = nameOf(record.content, 80) || "（未命名记忆）";
      const body = String(record.content ?? "").replace(/\r?\n/g, "\n  ");
      lines.push(`- [${record.namespace}] ${title}`, `  ${body}`);
    }
    lines.push("<");
    return createUserMessage({
      content: [{ type: "text", text: lines.join("\n") }],
      source: { kind: "plugin", plugin: "kaz-memory", form: "recall" },
    });
  }

  // ---- 面板数据通道（Connection RPC，不经过 settings.yaml） ----
  // 客户端经 createWebConnectionRpc() 调用 /kaz-memory 通道；记忆数据（含 name）
  // 全部存在 JSON 文件里，settings.yaml 不再承载任何记忆存储信息。
  function rootOf(payload) {
    if (payload !== null && typeof payload === "object" && typeof payload.project === "string" && payload.project.length > 0) {
      return payload.project;
    }
    return currentProjectRoot() ?? process.cwd();
  }
  function rpcFail(message) {
    return { ok: false, error: { code: "internal", message: String(message), details: {} } };
  }
  async function rpcFindRecord(id, project) {
    const records = await memory.list({ projectRoot: project });
    return records.find((item) => String(item.id) === String(id));
  }
  const rpcHandler = async (endpoint, payload, _signal) => {
    try {
      if (endpoint === "list") {
        const project = rootOf(payload);
        const records = await memory.list({ projectRoot: project });
        return {
          ok: true,
          value: {
            memories: records.map(metaValue).sort((a, b) => b.updatedAt - a.updatedAt),
            paths: {
              global: memory.globalStoragesRoot(),
              project: memory.projectStoragesRoot(project),
            },
          },
        };
      }
      if (endpoint === "open") {
        const project = rootOf(payload);
        const record = await rpcFindRecord(payload?.id, project);
        if (record === undefined) return rpcFail(`memory '${String(payload?.id)}' not found`);
        return {
          ok: true,
          value: {
            id: String(record.id),
            name: typeof record.name === "string" && record.name.length > 0 ? record.name : nameOf(record.content),
            content: record.content,
          },
        };
      }
      if (endpoint === "rename") {
        const record = await memory.setName(String(payload?.id), String(payload?.name ?? ""));
        return { ok: true, value: metaValue(record) };
      }
      if (endpoint === "status") {
        const status = payload?.status === "suggest" ? "suggest" : "auto";
        const record = await memory.setStatus(String(payload?.id), status);
        return { ok: true, value: metaValue(record) };
      }
      if (endpoint === "autoLoad") {
        const record = await memory.setAutoLoad(String(payload?.id), payload?.autoLoad === true);
        return { ok: true, value: metaValue(record) };
      }
      if (endpoint === "forget") {
        const deleted = await memory.forget(String(payload?.id));
        return { ok: true, value: { deleted } };
      }
      if (endpoint === "openFolder") {
        const target = payload?.target === "project" ? "project" : "global";
        const project = rootOf(payload);
        const folder = target === "project" ? memory.projectStoragesRoot(project) : memory.globalStoragesRoot();
        openFolderAction(folder);
        return { ok: true, value: { opened: true } };
      }
      return rpcFail(`unknown endpoint '${String(endpoint)}'`);
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] RPC ${String(endpoint)} 失败：${error instanceof Error ? error.message : String(error)}`);
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  };
  const connection = ctx.get("connection");
  if (connection !== undefined && connection !== null && connection.rpc !== undefined && typeof connection.rpc.handle === "function") {
    const disposeRpc = connection.rpc.handle("/kaz-memory", rpcHandler, { authority: "loopback" });
    ctx.effect(() => () => { void disposeRpc(); });
  } else {
    ctx.logger.warn("[kaz-memory] connection 服务不可用，面板 RPC 通道未注册（仅工具与自动载入可用）");
  }

  // ---- 首轮工具调用后的指引注入：settings 里 guidance 留空则发固定总述行
  // （工具细节由工具描述自带，不再重复 A/B/C/D 行）；仅在 memory_search 当前
  // 环境可调用时，以合成用户消息注入一次。Kaz 模式会把 systemPrompt 段全部滤掉，
  // 所以这里不再注册 tool:memory:kaz-memory 段，改为 pre-step 上下文注入。----
  const guidanceText = (agent) => {
    const current = source();
    // 组件总开关：关闭时不注入任何记忆指引（round-display 上报随内容为空自然跳过）。
    if (current === null || typeof current !== "object" || current.enabled === false) return "";
    const legacy =
      current !== null && typeof current === "object" && typeof current.guidance === "string"
        ? current.guidance.trim()
        : "";
    if (legacy.length > 0) return legacy; // 旧字段 guidance：整段覆盖（兼容旧配置）
    const settings = getSettings();
    let kazSettings;
    try {
      kazSettings = settings === undefined ? undefined : settings.get(settingsNamespace("kaz-mode"));
    } catch {
      kazSettings = undefined;
    }
    const head =
      current !== null && typeof current === "object" && typeof current.guidanceHead === "string"
        ? current.guidanceHead
        : "";
    return composeGuidance(ctx.get("toolGrouping"), kazSettings, { head }, agent, ctx.get("tools"), ctx.get("roundMinimal"));
  };
  /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
   *  服务不存在时静默跳过，不影响主流程。 */
  function reportRoundDisplay(agent, content) {
    try {
      const rd = ctx.get("roundDisplay");
      if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
        rd.report({ agent, plugin: "kaz-memory", title: "guidance", content });
      }
    } catch (error) {
      ctx.logger.debug(`[kaz-memory] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 从 createUserMessage 返回值里取纯文本（content 数组首个 text 块）。 */
  function recallTextOf(recall) {
    try {
      const blocks = recall !== null && typeof recall === "object" ? recall.content : undefined;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
        }
      }
    } catch {
      return "";
    }
    return "";
  }

  /** 会话里是否已发生第一次工具调用。 */
  function hasToolCall(agent) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      return events.some((event) => event !== null && typeof event === "object" && event.type === "tool/call");
    } catch {
      return false;
    }
  }

  /**
   * 会话日志里是否已注入过 kaz-memory 的消息（自动载入 recall 或固定指引 guidance）。
   * 这是跨重启去重的最终防线：无论标记文件是否及时写入、agent 是否在插件加载时
   * 已被枚举到，只要会话历史里已经出现过 kaz-memory 的注入记录，就不再注入。
   */
  function hasInjectedBefore(agent, form) {
    try {
      const events = agent?.session?.events;
      if (!Array.isArray(events)) return false;
      return events.some((event) => {
        if (event === null || typeof event !== "object" || event.type !== "user/message") return false;
        const data = event.data;
        if (data === null || typeof data !== "object") return false;
        const source = data.source;
        if (source === null || typeof source !== "object") return false;
        if (source.kind !== "plugin" || source.plugin !== "kaz-memory") return false;
        if (form !== undefined && source.form !== form) return false;
        return true;
      });
    } catch {
      return false;
    }
  }

  // ---- 自动载入：对话开始时（首个 pre-step）把已确认且标记「自动载入」的记忆
  // 注入一次（2026-08 重构：不再等 memory_search 首次可用——对话一开始就注入）----
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    if (payload === null || typeof payload !== "object" || payload.step !== 1) return decision;
    const agent = payload.agent;
    if (agent === null || agent === undefined || typeof agent !== "object") return decision;
    // 组件总开关：关闭时不做自动载入注入。
    if (source().enabled === false) return decision;
    if (autoLoadInjected.has(agent)) return decision;
    // 跨重启去重：该会话此前已注入过（持久化标记）→ 跳过。
    if (agent.id !== undefined && persistedInjected.has(String(agent.id))) return decision;
    // 最终防线：会话日志里已出现过 kaz-memory 自动载入记录 → 跳过。
    if (hasInjectedBefore(agent, "recall")) return decision;
    const recall = await buildAutoLoadMessage(agent);
    if (recall === undefined) return decision;
    // 实际注入成功后才落标（进程内 + 持久化）。
    autoLoadInjected.set(agent, true);
    if (agent.id !== undefined) {
      persistedInjected.add(String(agent.id));
      persistInjected();
    }
    // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
    reportRoundDisplay(agent, recallTextOf(recall));
    return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, recall] : decision.messages };
  });

  // ---- 固定指引：首轮工具调用之后以上下文消息注入一次 ----
  // Kaz 模式固定系统提示词会滤掉所有非 persona 段，因此固定指引不再注册
  // systemPrompt.section；改为在会话已有第一次 tool/call 后的某个 pre-step
  // 以合成用户消息注入一次（round-display 同步上报）。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === null || agent === undefined || typeof agent !== "object") return decision;
    if (guidanceInjected.has(agent)) return decision;
    // 跨重启去重：该会话此前已注入过固定指引 → 跳过。
    if (agent.id !== undefined && persistedGuidanceInjected.has(String(agent.id))) return decision;
    // 最终防线：会话日志里已出现过 kaz-memory 固定指引记录 → 跳过。
    if (hasInjectedBefore(agent, "guidance")) return decision;
    // 首轮工具调用之后才注入：此时 memory_search 已进入工具面。
    if (!hasToolCall(agent)) return decision;
    const text = guidanceText(agent);
    if (typeof text !== "string" || text.trim().length === 0) return decision;
    let message;
    try {
      message = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "kaz-memory", form: "guidance" },
      });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 构造指引注入消息失败：${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
    guidanceInjected.set(agent, true);
    if (agent.id !== undefined) {
      persistedGuidanceInjected.add(String(agent.id));
      persistInjected();
    }
    reportRoundDisplay(agent, text);
    return { ...decision, messages: Array.isArray(decision.messages) ? [...decision.messages, message] : decision.messages };
  });

  // ---- 组装层兜底：无条件移除基础英文记忆指引（tool:memory）----
  // kaz-memory 不再注册 tool:memory:kaz-memory 系统提示段；固定指引改为首轮
  // 工具调用后以上下文消息注入。这里保留全模式兜底：任何会话、任何模式都
  // 不再注入基础英文记忆指引（tool:memory）。
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    if (assembly !== null && typeof assembly === "object" && Array.isArray(assembly.sections)) {
      assembly.sections = assembly.sections.filter(
        (section) => !(section !== null && typeof section === "object" && section.name === "tool:memory"),
      );
    }
    return next();
  });

  // ---- 四工具（与 @max-null/dsh-memory 同名同 schema 同行为） ----
  ctx.tools.register(
    defineTool({
      name: "memory_save",
      description:
        "记录一条跨会话记忆作为「建议」（suggested）。它不会自动生效——必须由人在 Web 面板确认后才变为 auto；模型不得把建议当作已确认。namespace=project 时存入当前项目文件夹（<项目>/.dsh/storages/memory_project.json）。",
      parameters: {
        content: { type: "string", required: true, description: "记忆正文（纯文本）。" },
        namespace: { type: "string", enum: ["global", "project"], description: "适用范围：global 全局 / project 项目文件夹；默认 global。" },
        keywords: { type: "array", items: { type: "string" }, description: "供 memory_search 检索的显式锚点词。" },
      },
      output: {
        schema: RECORD_SCHEMA,
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        return Promise.resolve(
          memory.remember({
            content: args.content,
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            ...(args.keywords === undefined ? {} : { keywords: args.keywords }),
            projectRoot: projectRootOf(exec),
          }),
        ).then(recordValue);
      },
      presentCall: (args) => present("保存记忆", "other", args.content),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_list",
      description:
        "列出所有记忆，每条只返回 id/namespace/status/autoLoad/名称（名称取标题行或首行、超长截断 ≤140 字），不含正文和 keywords。想看全文用 memory_search。",
      parameters: {
        namespace: { type: "string", enum: ["global", "project"], description: "限定某个命名空间；project = 当前项目文件夹的记忆。" },
        status: { type: "string", enum: ["suggested", "auto", "suggest"], description: "限定某个状态。" },
      },
      output: {
        schema: { type: "array", items: LIST_RECORD_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        return Promise.resolve(
          memory.list({
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            ...(args.status === undefined ? {} : { status: args.status }),
            projectRoot: projectRootOf(exec),
          }),
        ).then((records) => records.map(nameValue));
      },
      presentCall: () => present("列出记忆", "read"),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_search",
      description:
        "按关键字检索记忆并返回全文。确定性字面匹配——未命中即表示没有任何已存储的词与查询匹配。",
      parameters: {
        query: { type: "string", required: true, description: "关键字查询。" },
        namespace: { type: "string", enum: ["global", "project"], description: "限定某个命名空间；project = 当前项目文件夹的记忆。" },
        status: { type: "string", enum: ["suggested", "auto", "suggest"], description: "限定某个状态。" },
      },
      output: {
        schema: { type: "array", items: HIT_SCHEMA },
        render: (_args, value) => renderJson(value),
      },
      execute(args, exec) {
        return Promise.resolve(
          memory.search(args.query, {
            ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
            ...(args.status === undefined ? {} : { status: args.status }),
            projectRoot: projectRootOf(exec),
          }),
        ).then((hits) => hits.map(hitValue));
      },
      presentCall: (args) => present("搜索记忆", "read", args.query),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "memory_forget",
      description: "按 id 删除一条记忆。主人可删除任意记忆。",
      parameters: {
        id: { type: "string", required: true, description: "要删除的记忆 id（取自 memory_list 或 memory_search）。" },
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { deleted: { type: "boolean", required: true } } },
        render: (_args, value) => renderJson(value),
      },
      execute(args, _exec) {
        return Promise.resolve(memory.forget(args.id)).then((deleted) => ({ deleted }));
      },
      presentCall: (args) => present("删除记忆", "other", args.id),
    }),
  );

  /** 在文件管理器中打开一个文件夹（先确保目录存在；探针可用 config.openFolder 覆盖）。 */
  function openFolder(folder) {
    try {
      mkdirSync(folder, { recursive: true });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 确保记忆文件夹存在失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const platform = process.platform;
    const command = platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open";
    let child;
    try {
      child = spawn(command, [folder], { stdio: "ignore", detached: true });
    } catch (error) {
      ctx.logger.warn(`[kaz-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    child.on("error", (error) => ctx.logger.warn(`[kaz-memory] 打开文件夹失败：${error instanceof Error ? error.message : String(error)}`));
    child.unref();
  }
  const openFolderAction = typeof config.openFolder === "function" ? config.openFolder : openFolder;

  installSettingsWithDefaults(
    ctx,
    NAMESPACE,
    SETTINGS_SCHEMA,
    {
      enabled: true,
      guidance: "",
      guidanceHead: "",
      guidanceSearch: "",
      guidanceSave: "",
      guidanceList: "",
      guidanceForget: "",
    },
    DEFAULT_SECTION,
    {
      setSource: (getValue) => {
        source = () => getValue();
      },
      onChange: () => {},
    },
  );
}
