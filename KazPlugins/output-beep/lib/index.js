// output-beep —— 模型输出完毕提示音
// ===========================================================================
// 宿主侧插件：监听 agent/status，任意 agent 输出完毕（回到 idle）时播放一次
// Windows 系统提示音（PowerShell [console]::beep，频率/时长可配）；同时监听
// session/event 的 ask_user_question 工具调用，模型提问弹窗出现时也响一次。
// 默认只对主会话提示（includeSubagents=false 时忽略子代理会话——它们完成时
// 同样会发 agent/status，避免子代理批量完成时提示音连响）。
//
// settings 命名空间 `output-beep`（~/.dsh/settings.yaml，热重载）：
//   enabled          总开关（默认 true）
//   includeSubagents 子代理输出完毕也提示（默认 false）
//   frequency        提示音频率 Hz（默认 1000，范围 37–32767）
//   duration         提示音时长 ms（默认 300）
//
// Kaz 模式把它作为第 6 个被管理插件（Kaz 面板开关行；进入 Kaz 联动启用、
// 关闭 Kaz 保持当前状态）；也可独立安装使用——cordis.patch.yml 加一行即可，
// 与 Kaz 模式完全解耦。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { execFile } from "node:child_process";

export const name = "output-beep";

const NAMESPACE = settingsNamespace("output-beep");

const DEFAULT_FREQUENCY = 1000;
const DEFAULT_DURATION = 300;
const MIN_FREQUENCY = 37;
const MAX_FREQUENCY = 32767;
/** 防抖窗口：同一时刻多个 agent 同时 idle（主会话 + 子代理）只响一次。 */
const BEEP_DEBOUNCE_MS = 200;

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  frequency: z.number().default(DEFAULT_FREQUENCY),
  duration: z.number().default(DEFAULT_DURATION),
});

/** 本插件 settings.yaml 段的默认配置（镜像作者 settings.yaml；仅含非运行时字段）。 */
export const DEFAULT_SECTION = {
  enabled: true,
  includeSubagents: false,
  frequency: DEFAULT_FREQUENCY,
  duration: DEFAULT_DURATION,
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


function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 播放一次 Windows 提示音。
 * 优先用 System.Media.SoundPlayer 播放内存合成的正弦波 WAV（44.1kHz 16bit
 * mono，支持 frequency/duration）——不依赖可见控制台，隐藏窗口/后台进程下
 * 也可靠；SoundPlayer 失败时回退 [console]::beep（老式路径，隐藏窗口下可能
 * 静默）。块 ID（RIFF/WAVE/fmt /data）用 ASCII 编码写入，避免字节序写反
 * 导致 "The wave header is corrupt"（2026-08-21 修复：此前 0x57415645 等
 * 小端魔数把 WAVE/fmt /data 写成了 EVAW/" tmf"/atad）。
 */
function playBeep(frequency, duration, logger) {
  const freq = Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, Math.round(Number(frequency) || DEFAULT_FREQUENCY)));
  const dur = Math.max(1, Math.round(Number(duration) || DEFAULT_DURATION));
  const command =
    `$f=${freq};$d=${dur};$sr=44100;$n=[int]($sr*$d/1000);` +
    `$enc=[System.Text.Encoding]::ASCII;` +
    `$ms=New-Object System.IO.MemoryStream;$w=New-Object System.IO.BinaryWriter($ms);` +
    `$w.Write($enc.GetBytes('RIFF'));$w.Write([int](36+$n*2));$w.Write($enc.GetBytes('WAVE'));` +
    `$w.Write($enc.GetBytes('fmt '));$w.Write([int]16);$w.Write([int16]1);$w.Write([int16]1);` +
    `$w.Write([int]$sr);$w.Write([int]($sr*2));$w.Write([int16]2);$w.Write([int16]16);` +
    `$w.Write($enc.GetBytes('data'));$w.Write([int]($n*2));` +
    `$amp=[int](32767*0.4);for($i=0;$i -lt $n;$i++){ $v=[int]($amp*[math]::Sin(2*[math]::PI*$f*$i/$sr)); $w.Write([int16]$v) };` +
    `$w.Flush();$w.BaseStream.Position=0;` +
    `try{ $p=[System.Media.SoundPlayer]::new($w.BaseStream); $p.PlaySync(); Write-Output 'SP_OK' }` +
    `catch{ Write-Output ('SP_ERR: '+$_.Exception.Message); try{ [console]::beep($f,$d); Write-Output 'BEEP_OK' }catch{ Write-Output ('BEEP_ERR: '+$_.Exception.Message) } };` +
    `$w.Close()`;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 8000 },
    (error, stdout, stderr) => {
      const out = String(stdout || "").trim();
      const err = String(stderr || "").trim();
      if (error) {
        logger?.warn?.(`[output-beep] 播放提示音失败: ${safeMessage(error)}${out ? " | " + out : ""}${err ? " | stderr: " + err : ""}`);
      } else {
        logger?.info?.(`[output-beep] 提示音结果: ${out || "ok"} (freq=${freq}Hz, dur=${dur}ms)`);
      }
    },
  );
}

export function apply(ctx, config = {}) {
  const entry = {
    enabled: config.enabled !== false,
    includeSubagents: config.includeSubagents === true,
    frequency: Number.isFinite(config.frequency) ? config.frequency : DEFAULT_FREQUENCY,
    duration: Number.isFinite(config.duration) ? config.duration : DEFAULT_DURATION,
  };
  // setSource 收到的是 thunk（() => scope.get()），scope.get() 已按 schema 解析出默认值。
  let source = () => entry;

  /** 判断是否子代理会话（header.origin === "subagent" 或带 parentSession）。 */
  function isSubagentHeader(header) {
    if (header === null || header === undefined || typeof header !== "object") return false;
    return header.origin === "subagent" || typeof header.parentSession === "string";
  }

  /** agent 形态：从 agent.session.header 判断。 */
  function isSubagent(agent) {
    try {
      return isSubagentHeader(agent?.session?.header);
    } catch {
      return false;
    }
  }

  /** session/event 形态：直接从 session.header 判断。 */
  function isSubagentSession(session) {
    try {
      return isSubagentHeader(session?.header);
    } catch {
      return false;
    }
  }

  let lastBeepAt = 0;

  /** 生效配置 = kazMode.pluginConfig（完整）；服务缺失时回落到插件自身 settings.yaml。 */
  function liveFor(agent) {
    try {
      const svc = ctx.get("kazMode");
      if (svc !== undefined && svc !== null && typeof svc.pluginConfig === "function") {
        const cfg = svc.pluginConfig(agent, "output-beep");
        if (cfg !== null && cfg !== undefined && typeof cfg === "object") return cfg;
      }
    } catch {
      // fall through
    }
    return source();
  }

  /** 从 session 形态解析对应 agent（session/event 事件只给 session，没有 agent）。 */
  function sessionAgentOf(session) {
    try {
      const id =
        session !== null && typeof session === "object" && typeof session.id === "string"
          ? session.id
          : session?.sessionId;
      if (typeof id === "string" && id.length > 0) {
        const agents = ctx.get("agents");
        if (agents !== undefined && agents !== null && typeof agents.get === "function") {
          const agent = agents.get(id);
          if (agent !== undefined && agent !== null) return agent;
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  /** 播放前的统一判定 + 防抖；subagent 参数表示当前事件是否来自子代理。 */
  function handleBeep(current, subagent) {
    if (current === null || typeof current !== "object" || current.enabled !== true) return;
    if (current.includeSubagents !== true && subagent) return;
    const now = Date.now();
    if (now - lastBeepAt < BEEP_DEBOUNCE_MS) return;
    lastBeepAt = now;
    playBeep(current.frequency, current.duration, ctx.logger);
  }

  function handleIdle(agent) {
    handleBeep(liveFor(agent), isSubagent(agent));
  }

  /** 模型调用 ask_user_question 提问时立即响一声（不等整轮结束 idle）。 */
  function handleAsk(session) {
    handleBeep(liveFor(sessionAgentOf(session)), isSubagentSession(session));
  }

  // agent 回到 idle = 整个驱动循环结束（可能含多个 turn/step）= 模型输出完毕。
  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle") return;
    handleIdle(agent);
  });

  // 模型调用 ask_user_question 时，UI 出现提问弹窗，立即响一声提醒用户。
  ctx.on("session/event", (session, event) => {
    if (event === null || typeof event !== "object" || event.type !== "tool/call") return;
    const data = event.data;
    if (data === null || typeof data !== "object" || data.name !== "ask_user_question") return;
    handleAsk(session);
  });

  installSettingsWithDefaults(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, DEFAULT_SECTION, {
    setSource: (getValue) => {
      source = getValue;
    },
    onChange: () => {
      const current = source();
      ctx.logger.info(
        `[output-beep] 配置已生效: enabled=${current?.enabled !== false}, includeSubagents=${current?.includeSubagents === true}, ` +
          `frequency=${current?.frequency}, duration=${current?.duration}`,
      );
    },
  });
}
