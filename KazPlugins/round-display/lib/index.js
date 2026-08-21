// round-display
// ===========================================================================
// 「每轮注入显示」插件（Kaz 模式附属）——只负责显示，不向模型注入任何内容：
//
//   1) 主动上报：发布 roundDisplay 服务（report 接口），其它要发送信息的插件
//      在发送时调用 ctx.get("roundDisplay")?.report({ agent, plugin, title, content })
//      告诉本插件要显示（best-effort：服务不存在时静默跳过，不影响主流程）。
//      （2026-08-21：删除旧的"被动捕获组装段"逻辑——thinking-anchor / kaz-memory
//      已改为消息注入，且 kaz-mode 会把非 persona 提示段滤掉，组装层根本读不到
//      它们的段；现在所有展示内容全部来自各插件的主动 report。）
//   2) 面板通道：专用 RPC（/round-display，loopback）——list 返回当前轮
//      （最近 turn/start 的 data.turn；每次用户发一条消息 = 一轮）的注入记录，
//      history 返回全部轮次，供客户端面板轮询显示。
//   3) 持久化（2026-08-21）：记录按 agent × 轮次落盘到
//      <DSH_HOME>/storages/round-display-records.json（config.recordsStore 可覆盖，
//      探针用临时文件），dsh 重启后恢复——重启后 history 仍能看到此前各轮的
//      注入记录，当前轮记录照常追加。写入防抖（1s），卸载时 flush。
//
// settings 命名空间 round-display（~/.dsh/settings.yaml，热重载）：
//   enabled  总开关（默认 true）
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 设置命名空间：~/.dsh/settings.yaml 中的 round-display: 段。 */
const NAMESPACE = settingsNamespace("round-display");

/** 面板专用 RPC 通道。 */
const RPC_CHANNEL = "/round-display";

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
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


/** 读取代理当前轮次：会话日志中最近一个 turn/start 的 data.turn；无则 0。
 *  与 round-minimal / kaz-memory 同款判定。 */
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

export default {
  name: "round-display",
  // connection：面板 RPC 通道。（2026-08-21：不再监听 system-prompt/assemble——
  // 被动捕获段已删除，展示内容全部来自各插件的主动 report。）
  inject: ["connection"],
  apply(ctx, config = {}) {
    const entry = { enabled: config.enabled !== false };
    let source = () => entry;
    installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
      setSource: (current) => {
        source = current;
      },
      onChange: () => {},
    });

    /** agentId -> Map<turn, Entry[]> */
    const byAgent = new Map();

    // ---- 持久化（重启后 history 仍可见；2026-08-21） ----
    const RECORDS_STORE =
      typeof config.recordsStore === "string" && config.recordsStore.trim().length > 0
        ? config.recordsStore.trim()
        : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "round-display-records.json");

    /** 每个 agent 最多保留的轮次数（防止无限膨胀；新轮优先）。 */
    const MAX_TURNS_PER_AGENT = 200;

    /** 截断单个 agent 的轮次 Map：只保留最大的 MAX_TURNS_PER_AGENT 个轮次。 */
    function pruneTurns(byTurn) {
      if (byTurn.size <= MAX_TURNS_PER_AGENT) return;
      const turns = [...byTurn.keys()].sort((a, b) => a - b);
      const removeCount = byTurn.size - MAX_TURNS_PER_AGENT;
      for (const turn of turns.slice(0, removeCount)) byTurn.delete(turn);
    }

    /** 加载持久化记录：{ agents: { [agentId]: { [turn]: Entry[] } } }。 */
    function loadRecords() {
      try {
        if (!existsSync(RECORDS_STORE)) return;
        let raw = readFileSync(RECORDS_STORE, "utf8");
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        const parsed = JSON.parse(raw);
        const agents = parsed !== null && typeof parsed === "object" ? parsed.agents : undefined;
        if (agents === null || typeof agents !== "object") return;
        for (const [id, byTurnRaw] of Object.entries(agents)) {
          if (byTurnRaw === null || typeof byTurnRaw !== "object") continue;
          const byTurn = new Map();
          for (const [turnStr, list] of Object.entries(byTurnRaw)) {
            const turn = Number(turnStr);
            if (!Number.isInteger(turn) || !Array.isArray(list)) continue;
            const entries = [];
            for (const item of list) {
              if (item === null || typeof item !== "object") continue;
              const content = typeof item.content === "string" ? item.content : "";
              if (content.trim().length === 0) continue;
              const plugin = typeof item.plugin === "string" ? item.plugin : "";
              entries.push({
                key: plugin + "|" + content,
                plugin,
                title: typeof item.title === "string" ? item.title : "",
                content,
                at: typeof item.at === "number" ? item.at : Date.now(),
              });
            }
            if (entries.length > 0) byTurn.set(turn, entries);
          }
          if (byTurn.size > 0) {
            byAgent.set(id, byTurn);
            pruneTurns(byTurn);
          }
        }
        ctx.logger.info('[round-display] 已从持久化记录恢复 ' + byAgent.size + ' 个 agent 的历史');
      } catch (error) {
        ctx.logger.warn('[round-display] 读取持久化记录失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }

    let persistTimer = null;
    /** 防抖落盘（1s）；卸载时由 ctx.effect 兜底 flush。 */
    function schedulePersist() {
      if (persistTimer !== null) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
          const agents = {};
          for (const [id, byTurn] of byAgent) {
            const turns = {};
            for (const [turn, entries] of byTurn) {
              turns[turn] = entries.map((item) => ({
                plugin: item.plugin,
                title: item.title,
                content: item.content,
                at: item.at,
              }));
            }
            agents[id] = turns;
          }
          mkdirSync(dirname(RECORDS_STORE), { recursive: true });
          writeFileSync(
            RECORDS_STORE,
            JSON.stringify({ agents, updatedAt: Date.now() }, null, 2) + String.fromCharCode(10),
            "utf8",
          );
        } catch (error) {
          ctx.logger.debug('[round-display] 持久化记录失败：' + (error instanceof Error ? error.message : String(error)));
        }
      }, 1000);
    }

    /** 记录一条注入：agent + 当前轮次 + (plugin, content) 去重（title 仅展示用）。 */
    function record(agent, plugin, title, content) {
      if (source().enabled !== true) return;
      if (agent === null || typeof agent !== "object") return;
      const id = agent.id;
      if (id === undefined) return;
      if (typeof content !== "string" || content.trim().length === 0) return;
      const turn = currentTurnOf(agent);
      let byTurn = byAgent.get(id);
      if (byTurn === undefined) {
        byTurn = new Map();
        byAgent.set(id, byTurn);
      }
      let entries = byTurn.get(turn);
      if (entries === undefined) {
        entries = [];
        byTurn.set(turn, entries);
      }
      const key = String(plugin ?? "") + "|" + content;
      if (entries.some((item) => item.key === key)) return;
      entries.push({
        key,
        plugin: String(plugin ?? ""),
        title: typeof title === "string" ? title : "",
        content,
        at: Date.now(),
      });
      pruneTurns(byTurn);
      schedulePersist();
    }

    // -----------------------------------------------------------------------
    // 1) 主动上报服务：其它要发送信息的插件在发送时调用 report() 告诉本插件
    // -----------------------------------------------------------------------
    const roundDisplayService = {
      version: 1,
      report(payload) {
        try {
          const value = payload !== null && typeof payload === "object" ? payload : {};
          record(value.agent, value.plugin, value.title, value.content);
        } catch (error) {
          ctx.logger.debug("[round-display] report 失败：" + (error instanceof Error ? error.message : String(error)));
        }
      },
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("roundDisplay", roundDisplayService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "round-display: 发布 roundDisplay 上报服务");

    // ---- agent 销毁时清理记录（内存删除 + 落盘同步，避免重启后回退） ----
    ctx.on("agent/disposed", (payload) => {
      const id = payload !== null && typeof payload === "object" ? payload.agent?.id : undefined;
      if (id !== undefined) {
        byAgent.delete(id);
        schedulePersist();
      }
    });

    // 启动时恢复持久化记录（dsh 重启后 history 仍可见）。
    loadRecords();

    // -----------------------------------------------------------------------
    // 2) 面板 RPC 通道（/round-display，loopback）：list = 当前轮；history = 全部轮
    // -----------------------------------------------------------------------
    function rpcFail(message) {
      return { ok: false, error: { code: "internal", message: String(message), details: {} } };
    }
    function toPublic(entry) {
      return { plugin: entry.plugin, title: entry.title, content: entry.content };
    }
    const rpcHandler = async (endpoint, payload) => {
      try {
        if (endpoint === "list") {
          const sessionId =
            payload !== null && typeof payload === "object" && typeof payload.sessionId === "string"
              ? payload.sessionId
              : undefined;
          let turn = 0;
          let entries = [];
          if (typeof sessionId === "string" && sessionId.length > 0) {
            const agents = ctx.get("agents");
            const agent =
              agents !== undefined && agents !== null && typeof agents.get === "function"
                ? agents.get(sessionId)
                : undefined;
            if (agent !== undefined) {
              turn = currentTurnOf(agent);
              const byTurn = byAgent.get(agent.id);
              const list = byTurn !== undefined ? byTurn.get(turn) : undefined;
              if (Array.isArray(list)) {
                entries = list
                  .slice()
                  .sort((a, b) => a.at - b.at)
                  .map(toPublic);
              }
            }
          }
          return { ok: true, value: { turn, entries } };
        }
        if (endpoint === "history") {
          const sessionId =
            payload !== null && typeof payload === "object" && typeof payload.sessionId === "string"
              ? payload.sessionId
              : undefined;
          let turns = [];
          if (typeof sessionId === "string" && sessionId.length > 0) {
            const agents = ctx.get("agents");
            const agent =
              agents !== undefined && agents !== null && typeof agents.get === "function"
                ? agents.get(sessionId)
                : undefined;
            if (agent !== undefined) {
              const byTurn = byAgent.get(agent.id);
              if (byTurn !== undefined) {
                turns = [...byTurn.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([turn, list]) => ({
                    turn,
                    entries: list
                      .slice()
                      .sort((a, b) => a.at - b.at)
                      .map(toPublic),
                  }));
              }
            }
          }
          return { ok: true, value: { turns } };
        }
        return rpcFail("unknown endpoint '" + String(endpoint) + "'");
      } catch (error) {
        ctx.logger.warn(
          "[round-display] RPC " + String(endpoint) + " 失败：" + (error instanceof Error ? error.message : String(error)),
        );
        return rpcFail(error instanceof Error ? error.message : String(error));
      }
    };
    const connection = ctx.get("connection");
    if (
      connection !== undefined &&
      connection !== null &&
      connection.rpc !== undefined &&
      typeof connection.rpc.handle === "function"
    ) {
      const disposeRpc = connection.rpc.handle(RPC_CHANNEL, rpcHandler, { authority: "loopback" });
      ctx.effect(() => () => {
        void disposeRpc();
      });
    } else {
      ctx.logger.warn("[round-display] connection 服务不可用，面板 RPC 通道未注册（仅捕获与上报可用）");
    }

    // 卸载时 flush 未落盘的记录。
    ctx.effect(() => () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      try {
        const agents = {};
        for (const [id, byTurn] of byAgent) {
          const turns = {};
          for (const [turn, entries] of byTurn) {
            turns[turn] = entries.map((item) => ({
              plugin: item.plugin,
              title: item.title,
              content: item.content,
              at: item.at,
            }));
          }
          agents[id] = turns;
        }
        mkdirSync(dirname(RECORDS_STORE), { recursive: true });
        writeFileSync(
          RECORDS_STORE,
          JSON.stringify({ agents, updatedAt: Date.now() }, null, 2) + String.fromCharCode(10),
          "utf8",
        );
      } catch (error) {
        ctx.logger.debug('[round-display] 卸载时持久化记录失败：' + (error instanceof Error ? error.message : String(error)));
      }
    });
  },
};
