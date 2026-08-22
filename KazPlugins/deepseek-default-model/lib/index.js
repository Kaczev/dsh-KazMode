// deepseek-default-model —— DeepSeek 模型默认采样参数（Kaz 面板可调）
// ===========================================================================
// 宿主侧插件：管理 DeepSeek 的 generation_kwargs（temperature / top_p /
// repetition_penalty），并通过 agent/request 瀑布把 generation_kwargs.temperature
// 应用到每个 agent-loop 请求（主会话与子代理会话都生效；官方管线没有其它
// temperature 来源，本插件的值作为默认且面板改动下一次请求即生效）。
//
// provider / model / reasoningEffort 不由本插件管理：默认模型与思考强度由 DSH
// 官方面板（agent-default-model 设置段）负责，本插件不再读取、写入或同步它们，
// 避免出现两个“默认模型真相来源”。
//
// settings 命名空间 `deepseek-default-model`（~/.dsh/settings.yaml，热重载）：
//   enabled            总开关（默认 true；关闭后不再应用默认参数，恢复 temperature
//                      放行，由 DeepSeek 官方默认 temperature=1 生效）
//   generation_kwargs
//     temperature         采样温度（默认 0.2，经 agent/request 应用到请求）
//     top_p               核采样（默认 0.9；DSH 请求管线暂不转发，仅存储/面板调整）
//     repetition_penalty  重复惩罚（默认 1.2；同上，仅存储/面板调整）
//
// 已知限制（如实说明）：DSH 的 GenerateOptions 只支持 temperature / maxTokens /
// stop —— top_p 与 repetition_penalty 不在请求管线的 wire 层，本插件负责保存
// 与在面板调整它们（保持与示例配置形状一致），但当前版本不会转发给提供方。
//
// Kaz 模式把它作为被管理插件（Kaz 面板开关行 + 配置字段）；也可独立安装使用。
// settings.yaml 中本插件段缺失时由 schema 默认值补齐；纯方案 A 下生效配置来自
// kazMode.pluginConfig，settings.yaml 仅 standalone 兜底。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

export const name = "deepseek-default-model";

/** 本插件的设置命名空间（settings.yaml 中 deepseek-default-model: 段）。 */
const NAMESPACE = settingsNamespace("deepseek-default-model");

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
    // 纯方案 A（2026-08-21）：不再自愈写 settings.yaml——生效配置由
    // kazMode.pluginConfig 提供，settings.yaml 插件段仅作 standalone 兜底。
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
  const num = (candidate, fallback) => (Number.isFinite(candidate) ? candidate : fallback);
  const kwargs = value.generation_kwargs !== null && typeof value.generation_kwargs === "object" ? value.generation_kwargs : {};
  return {
    enabled: value.enabled !== false,
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

  /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
  function liveFor(agent) {
    try {
      const svc = ctx.get("kazMode");
      if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
        const cfg = svc.pluginConfig(agent, "deepseek-default-model");
        if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
      }
    } catch {
      // fall through
    }
    return source();
  }

  // ---- settings 注册 + 自愈 ----
  installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
    setSource: (getValue) => {
      source = getValue;
    },
    onChange: () => {
      const current = source();
      ctx.logger.info(
        `[deepseek-default-model] 配置已生效: enabled=${current?.enabled !== false}, ` +
          `temperature=${current?.generation_kwargs?.temperature}, top_p=${current?.generation_kwargs?.top_p}, ` +
          `repetition_penalty=${current?.generation_kwargs?.repetition_penalty}`,
      );
    },
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
    const current = liveFor(payload?.agent);
    if (current === null || typeof current !== "object" || current.enabled !== true) {
      return proposal;
    }
    const temperature = current.generation_kwargs?.temperature;
    if (!Number.isFinite(temperature)) return proposal;
    if (proposal.temperature === temperature) return proposal;
    return { ...proposal, temperature };
  });
}
