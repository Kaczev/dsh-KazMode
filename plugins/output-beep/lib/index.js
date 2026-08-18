// output-beep —— 模型输出完毕提示音
// ===========================================================================
// 宿主侧插件：监听 agent/status，任意 agent 输出完毕（回到 idle）时播放一次
// Windows 系统提示音（PowerShell [console]::beep，频率/时长可配）。默认只对
// 主会话提示（includeSubagents=false 时忽略子代理会话——它们完成时同样会发
// agent/status，避免子代理批量完成时提示音连响）。
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
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
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

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 播放一次 Windows 提示音（[console]::beep(freq, duration)）。 */
function playBeep(frequency, duration, logger) {
  const freq = Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, Math.round(Number(frequency) || DEFAULT_FREQUENCY)));
  const dur = Math.max(1, Math.round(Number(duration) || DEFAULT_DURATION));
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `[console]::beep(${freq},${dur})`],
    { windowsHide: true, timeout: 5000 },
    (error) => {
      if (error) logger?.warn?.(`[output-beep] 播放提示音失败: ${safeMessage(error)}`);
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
  function isSubagent(agent) {
    try {
      const header = agent?.session?.header;
      if (header === null || header === undefined || typeof header !== "object") return false;
      return header.origin === "subagent" || typeof header.parentSession === "string";
    } catch {
      return false;
    }
  }

  let lastBeepAt = 0;

  function handleIdle(agent) {
    const current = source();
    if (current === null || typeof current !== "object" || current.enabled !== true) return;
    if (current.includeSubagents !== true && isSubagent(agent)) return;
    const now = Date.now();
    if (now - lastBeepAt < BEEP_DEBOUNCE_MS) return;
    lastBeepAt = now;
    playBeep(current.frequency, current.duration, ctx.logger);
  }

  // agent 回到 idle = 整个驱动循环结束（可能含多个 turn/step）= 模型输出完毕。
  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle") return;
    handleIdle(agent);
  });

  installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
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
