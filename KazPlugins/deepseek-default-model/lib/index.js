// deepseek-default-model —— DeepSeek 模型默认参数（Kaz 面板可调）
// ===========================================================================
// 宿主侧插件：管理 DeepSeek 默认模型参数，并把 provider / model /
// reasoningEffort 同步进官方 agent-default-model 设置段（dsh-agent-default-model
// 服务读取它来决定"新会话的默认模型选择"），同时通过 agent/request 瀑布把
// generation_kwargs.temperature 应用到每个 agent-loop 请求（主会话与子代理
// 会话都生效；官方管线没有其它 temperature 来源，本插件的值作为默认且面板
// 改动下一次请求即生效）。
//
// settings 命名空间 `deepseek-default-model`（~/.dsh/settings.yaml，热重载）：
//   enabled            总开关（默认 true；关闭后不再应用默认参数，恢复 temperature
//                      放行并把官方 agent-default-model 恢复到官方默认值）
//   provider           提供方路由（默认 deepseek-official）
//   model              默认模型（默认 deepseek-v4-flash）
//   reasoningEffort    默认思考强度（默认 high）
//   generation_kwargs
//     temperature         采样温度（默认 0.2，经 agent/request 应用到请求）
//     top_p               核采样（默认 1；DSH 请求管线暂不转发，仅存储/面板调整）
//     repetition_penalty  重复惩罚（默认 1.2；同上，仅存储/面板调整）
//
// 已知限制（如实说明）：DSH 的 GenerateOptions 只支持 temperature / maxTokens /
// stop —— top_p 与 repetition_penalty 不在请求管线的 wire 层，本插件负责保存
// 与在面板调整它们（保持与示例配置形状一致），但当前版本不会转发给提供方。
//
// Kaz 模式把它作为第 9 个被管理插件（Kaz 面板开关行 + 配置字段）；也可独立
// 安装使用。settings.yaml 中本插件段缺失时自动补齐默认值；官方 agent-default-model
// 段缺失键同样只补缺失（保留用户已有配置）。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

export const name = "deepseek-default-model";

/** 本插件的设置命名空间（settings.yaml 中 deepseek-default-model: 段）。 */
const NAMESPACE = settingsNamespace("deepseek-default-model");
/** 官方 agent-default-model 设置命名空间（由 dsh-base bundle 的
 *  @deepseek-ai/dsh-agent-default-model 插件注册；本插件只读写、不注册）。 */
const OFFICIAL_NS = settingsNamespace("agent-default-model");

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.9;
const DEFAULT_REPETITION_PENALTY = 1.2;

const GENERATION_KWARGS_DEFAULTS = {
  temperature: DEFAULT_TEMPERATURE,
  top_p: DEFAULT_TOP_P,
  repetition_penalty: DEFAULT_REPETITION_PENALTY,
};

/** “使用官方值”对应的 generation_kwargs：官方 DeepSeek 默认 temperature / top_p / repetition_penalty 都是 1。 */
export const OFFICIAL_GENERATION_KWARGS = {
  temperature: 1,
  top_p: 1,
  repetition_penalty: 1,
};

/** “使用 Kaz 模式的默认值”对应的 generation_kwargs（即本插件出厂默认）。 */
export const KAZ_GENERATION_KWARGS = { ...GENERATION_KWARGS_DEFAULTS };

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(DEFAULT_PROVIDER),
  model: z.string().default(DEFAULT_MODEL),
  reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT),
  generation_kwargs: z
    .object({
      temperature: z.number().default(DEFAULT_TEMPERATURE),
      top_p: z.number().default(DEFAULT_TOP_P),
      repetition_penalty: z.number().default(DEFAULT_REPETITION_PENALTY),
    })
    .default({ ...GENERATION_KWARGS_DEFAULTS }),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  generation_kwargs: { ...GENERATION_KWARGS_DEFAULTS },
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

/** 安全地把任意抛出的值转成可打印字符串。 */
function safeMessage(error) {
  try {
    if (error instanceof Error) return error.message;
    if (error !== null && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
  } catch {
    return "<不可打印的错误>";
  }
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
          logger?.info?.("[deepseek-default-model] settings.yaml config section auto-filled missing keys: " + Object.keys(patch).join(", "));
        },
        (error) => {
          logger?.warn?.("[deepseek-default-model] auto-fill defaults failed: " + safeMessage(error));
        },
      );
    }
    return patch;
  } catch (error) {
    logger?.warn?.("[deepseek-default-model] check defaults failed: " + safeMessage(error));
    return null;
  }
}

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const str = (candidate, fallback) =>
    typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : fallback;
  const num = (candidate, fallback) => (Number.isFinite(candidate) ? candidate : fallback);
  const kwargs = value.generation_kwargs !== null && typeof value.generation_kwargs === "object" ? value.generation_kwargs : {};
  return {
    enabled: value.enabled !== false,
    provider: str(value.provider, DEFAULT_PROVIDER),
    model: str(value.model, DEFAULT_MODEL),
    reasoningEffort: str(value.reasoningEffort, DEFAULT_REASONING_EFFORT),
    generation_kwargs: {
      temperature: num(kwargs.temperature, DEFAULT_TEMPERATURE),
      top_p: num(kwargs.top_p, DEFAULT_TOP_P),
      repetition_penalty: num(kwargs.repetition_penalty, DEFAULT_REPETITION_PENALTY),
    },
  };
}

export function apply(ctx, config = {}) {
  const entry = normalizeConfig(config);
  let source = () => entry;

  /** settings 服务惰性获取（apply 阶段可能尚未挂载）。 */
  const getSettings = () => ctx.get("settings");

  /** 本实例是否真的向官方 agent-default-model 段写过值；避免插件一开始就是关闭时误恢复。 */
  let everSynced = false;
  /** 本实例在本进程内写进官方段的键（关闭时只还原本插件写过的键，不碰其它键）。 */
  const syncedKeys = new Set();

  /** 把官方 agent-default-model 段中本插件写过的键恢复到插件默认值。
   *  2026-08-21 修复：原来用 settings.replace 整体覆盖，会丢掉官方段里用户/其它
   *  来源的键（如 reasoningEffort）；现在只 update 本插件写过的键，其余键原样保留。 */
  async function restoreOfficial() {
    if (!everSynced) return;
    const settings = getSettings();
    if (settings === undefined) return;
    const patch = {};
    if (syncedKeys.has("provider")) patch.provider = DEFAULT_PROVIDER;
    if (syncedKeys.has("model")) patch.model = DEFAULT_MODEL;
    if (syncedKeys.has("reasoningEffort")) patch.reasoningEffort = DEFAULT_REASONING_EFFORT;
    if (Object.keys(patch).length === 0) return;
    try {
      await settings.update(OFFICIAL_NS, patch);
      ctx.logger?.info?.(
        "[deepseek-default-model] 插件已关闭，恢复 agent-default-model 中本插件写过的键: " + JSON.stringify(patch),
      );
    } catch (error) {
      ctx.logger?.warn?.(
        "[deepseek-default-model] 恢复 agent-default-model 失败（官方 dsh-agent-default-model 未挂载？）: " + safeMessage(error),
      );
    }
  }

  /** 把本插件当前的 provider/model/reasoningEffort 同步进官方 agent-default-model
   *  设置段（官方服务热重载 → 新会话的默认模型选择立即更新）。仅在用户编辑
   *  本插件段后触发（见下方的 syncArmed 冷却窗口），并且只写与官方段当前
   *  解析值不同的键（避免无谓写入）。失败只记日志（官方插件未挂载时静默降级）。 */
  async function syncToOfficial(current) {
    if (current === null || typeof current !== "object" || current.enabled !== true) {
      await restoreOfficial();
      return;
    }
    const settings = getSettings();
    if (settings === undefined) return;
    const candidates = {
      provider: typeof current.provider === "string" && current.provider !== "" ? current.provider : DEFAULT_PROVIDER,
      model: typeof current.model === "string" && current.model !== "" ? current.model : DEFAULT_MODEL,
    };
    if (typeof current.reasoningEffort === "string" && current.reasoningEffort.trim() !== "") {
      candidates.reasoningEffort = current.reasoningEffort.trim();
    }
    const patch = {};
    let official;
    try {
      official = settings.get(OFFICIAL_NS);
    } catch {
      official = undefined;
    }
    for (const [key, value] of Object.entries(candidates)) {
      const currentOfficial = official !== undefined && official !== null && typeof official === "object" ? official[key] : undefined;
      if (currentOfficial !== value) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return;
    everSynced = true;
    for (const key of Object.keys(patch)) syncedKeys.add(key);
    try {
      await settings.update(OFFICIAL_NS, patch);
      ctx.logger?.info?.(
        "[deepseek-default-model] 已同步默认模型到 agent-default-model: " + JSON.stringify(patch),
      );
    } catch (error) {
      ctx.logger?.warn?.(
        "[deepseek-default-model] 同步 agent-default-model 失败（官方 dsh-agent-default-model 未挂载？）: " + safeMessage(error),
      );
    }
  }

  /** 官方 agent-default-model 段自愈：只补缺失键（provider/model/reasoningEffort），
   *  保留用户已有配置。官方段未注册（官方插件不在）时跳过。 */
  function fillOfficialMissing(settings) {
    try {
      const descriptor = settings.describe().find((item) => item.ns === OFFICIAL_NS);
      if (descriptor === undefined) return;
      const user =
        descriptor.user !== null && typeof descriptor.user === "object" ? descriptor.user : {};
      const patch = {};
      for (const key of ["provider", "model", "reasoningEffort"]) {
        if (!Object.prototype.hasOwnProperty.call(user, key)) patch[key] = DEFAULT_SECTION[key];
      }
      if (Object.keys(patch).length === 0) return;
      everSynced = true;
      for (const key of Object.keys(patch)) syncedKeys.add(key);
      const write = settings.update(OFFICIAL_NS, patch);
      if (write !== null && typeof write.then === "function") {
        void write.then(
          () => {
            ctx.logger?.info?.("[deepseek-default-model] agent-default-model 段已补齐缺失键: " + Object.keys(patch).join(", "));
          },
          (error) => {
            ctx.logger?.warn?.("[deepseek-default-model] 补齐 agent-default-model 段失败: " + safeMessage(error));
          },
        );
      }
    } catch (error) {
      ctx.logger?.warn?.("[deepseek-default-model] 检查 agent-default-model 段失败: " + safeMessage(error));
    }
  }

  // ---- settings 注册 + 自愈 + 联动 ----
  // 同步冷却窗口：注册期自动补齐本插件段（self-heal）会触发一次 watch，但那
  // 不是用户编辑——若同步到官方段会覆盖用户此前在官方模型选择器里设置的值。
  // 因此冷却 2 秒（足够注册期写入 settle），之后的变更（用户在 Kaz 面板编辑）
  // 才触发对官方段的同步。
  let syncArmed = false;
  ctx.effect(() => {
    const timer = setTimeout(() => {
      syncArmed = true;
    }, 2000);
    return () => clearTimeout(timer);
  }, "deepseek-default-model: arm official sync");

  installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
    setSource: (getValue) => {
      source = getValue;
    },
    onChange: () => {
      const current = source();
      ctx.logger.info(
        `[deepseek-default-model] 配置已生效: enabled=${current?.enabled !== false}, ` +
          `provider=${current?.provider}, model=${current?.model}, reasoningEffort=${current?.reasoningEffort}, ` +
          `temperature=${current?.generation_kwargs?.temperature}, top_p=${current?.generation_kwargs?.top_p}, ` +
          `repetition_penalty=${current?.generation_kwargs?.repetition_penalty}`,
      );
      // 用户在面板/settings.yaml 修改本插件段 → 同步默认模型到官方段（热重载生效）。
      if (syncArmed) void syncToOfficial(current);
    },
  });

  // 官方段自愈（只补缺失键）：在 settings 服务就绪后执行一次。
  // 如果插件当前启用且官方段用户层已有 reasoningEffort（官方组合层没有这个键，
  // 通常是本插件此前同步写入的），关闭时要允许恢复到官方默认值。
  ctx.inject(["settings"], (sctx) => {
    try {
      const descriptor = sctx.settings.describe().find((item) => item.ns === OFFICIAL_NS);
      const current = source();
      if (
        current !== null &&
        typeof current === "object" &&
        current.enabled === true &&
        descriptor !== undefined &&
        descriptor.user !== null &&
        typeof descriptor.user === "object" &&
        Object.prototype.hasOwnProperty.call(descriptor.user, "reasoningEffort")
      ) {
        everSynced = true;
      }
    } catch (error) {
      ctx.logger?.warn?.("[deepseek-default-model] 检查 agent-default-model 同步状态失败: " + safeMessage(error));
    }
    fillOfficialMissing(sctx.settings);
  });

  // ---- agent/request 瀑布：把默认 temperature 应用到 agent-loop 请求 ----
  // dsh-agent-loop 在每次模型调用前走 agent/request 瀑布得到 proposedConfig，
  // 再交给 llm.prepareCall()。这里在 prepareCall 之前补上 temperature：
  //   - 插件启用时：无条件写入面板当前值（DSH 官方管线没有其它 temperature
  //     来源，会话/适配器默认值为空，因此"写默认"不会覆盖任何显式选择）；
  //   - 插件关闭时：完全放行 proposal，不再删除/写入 temperature，从而恢复
  //     到插件修改前的状态（未显式设置时由 DeepSeek 官方默认 temperature=1 生效）。
  // 返回新对象（seed 是冻结的，不能原地改）。
  ctx.on("agent/request", async (payload, next) => {
    let proposal;
    try {
      proposal = await next();
    } catch (error) {
      ctx.logger?.warn?.("[deepseek-default-model] agent/request 下游处理失败: " + safeMessage(error));
      return proposal;
    }
    if (proposal === null || typeof proposal !== "object") return proposal;
    const current = source();
    if (current === null || typeof current !== "object" || current.enabled !== true) {
      return proposal;
    }
    const temperature = current.generation_kwargs?.temperature;
    if (!Number.isFinite(temperature)) return proposal;
    if (proposal.temperature === temperature) return proposal;
    return { ...proposal, temperature };
  });
}
