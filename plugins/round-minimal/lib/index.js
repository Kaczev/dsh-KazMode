// round-minimal
// ===========================================================================
// 按对话轮次切换工具集与提示策略：
//
//   1) 首轮（turn 1）——极简模式：
//        - 系统提示注入一个"首轮提示"段，告知模型：首轮对话仅用于了解任务
//          详情、可用工具较少，第二轮对话才有更多工具（提示只出现在首轮
//          组装中，不写入会话日志、不触碰用户输入）；
//        - 模型可见的工具只保留 firstRoundTools（默认 pwsh、str_replace_editor）：
//          组装层（system-prompt/assemble）把其它工具及 tool:* 指导段全部滤除，
//          执行层（tools/pre-execute）对白名单之外的调用一律拒绝（纵深防御）。
//   2) 第二轮（turn 2）——过渡提示：
//        - 系统提示注入"第二轮提示"段，告知模型：更多插件已加载、工具已全部
//          恢复，但别分心，请专注主要任务（同样只出现一次，不写入会话日志）。
//   3) 第三轮及以后（turn >= 3）——全量模式：
//        - 提示段输出空串；工具列表保持为组合/预设配置的全部工具；
//        - 判定不依赖进程内状态，对话历史（含首轮产生的文件、状态、目录）
//          完全连续，后续轮次的工具调用可正常访问。
//
// 轮次判定（可靠且无状态）：以会话日志中的 turn/start 事件为准。agent-loop
// 在每一轮请求的预置阶段（preStep，系统提示组装之前）先落盘 turn/start，
// 因此任意一次组装/执行时，读取会话中最近的 turn/start 的 data.turn 即当前
// 轮次：1 = 首轮。这也天然免疫重启续接旧对话——旧对话的 turn >= 2，直接走
// 全量模式，不会给老用户弹提示。
//
// 子代理：默认不受影响（includeSubagents=false）。subagentDepth > 0 或会话
// 含 subagent/descriptor 事件的代理（subagent / subagent_fork / workflow /
// ralph 的子会话）始终走全量模式，避免首轮极简模式破坏委托任务的执行能力。
//
// 对外信号：本插件把首轮极简状态发布为 roundMinimal 服务（enabled /
// firstRoundTools / isMinimal / turnOf），并在状态判定变化时发送
// round-minimal/state 事件（{ agent, minimal, turn, firstRoundTools }）——
// 供 kaz-mode 等消费方在首轮极简激活时抑制"请先搜索记忆"之类的指引
// （首轮没有 memory_search 等记忆工具）。
//
// 配置（热重载，写入 ~/.dsh/settings.yaml 的 round-minimal: 命名空间即可，
// 无需重启；组合行 cordis.patch.yml 的 config 作为 base 层，用户设置优先）：
//   enabled                是否启用，默认 true
//   firstRoundTools        首轮可用工具白名单，默认 ["pwsh", "str_replace_editor"]。
//                          存在且启用 task-master-whiteboard 插件时，自动追加其
//                          六个白板工具（new/list/read/append/update/clear_whiteboard），
//                          首轮即可用（无需手工配置）。
//   roundOneInstruction    首轮对模型的提示文本（统一消息格式：[标题] / > / 内容 / <，
//                          内置编码提醒）；settings 留空则用内置默认，默认
//                          "[round-minimal 首轮模式]…"
//   roundTwoInstruction    第二轮对模型的提示文本（同上格式），默认
//                          "[round-minimal 第二轮提示]…"
//   includeSubagents       是否对子代理也施加首轮极简模式，默认 false
//   showPolicy             是否输出轮次提示段（round-minimal:policy），默认 true。
//                          置 false 后首轮/第二轮提示都不注入（Kaz 模式联动期间
//                          由 kaz-mode 临时置 false 并快照，退出 Kaz 时按快照
//                          恢复原值——用户原本关着就恢复为关）。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** 设置命名空间：~/.dsh/settings.yaml 中的 round-minimal: 段。 */
const NAMESPACE = settingsNamespace("round-minimal");

/** 首轮极简工具集默认值：pwsh 为 Windows 原生 shell，str_replace_editor 覆盖常用文件编辑。 */
/** 反转：deepseek团队说不要使用pwsh，用bash最好 */
const DEFAULT_FIRST_ROUND_TOOLS = ["bash", "str_replace_editor"];

/** task-master-whiteboard 插件的六个白板工具（插件存在且启用时自动加入首轮工具集）。 */
const WHITEBOARD_TOOLS = [
  "new_whiteboard",
  "list_whiteboards",
  "read_whiteboard",
  "append_whiteboard",
  "update_whiteboard",
  "clear_whiteboard",
];

const WHITEBOARD_NAMESPACE = settingsNamespace("task-master-whiteboard");

/** 首轮对模型的提示默认文本（统一消息格式：[标题] / > / 内容 / <；We need 风格）。
 *  2026-08-19（Kaczev）：附上 run_code/pwsh 使用要点——把记忆里整合的易犯错误
 *  以简明英文写进首轮提示，正式执行前先过一遍。 */
const DEFAULT_ROUND_ONE_INSTRUCTION = [
  "[round-minimal First Round Mode]",
  ">",
  "We need to treat this as the first round: do not execute the task yet — only ask about the task details or wait for the user to provide them.",
  // "",
  // "[run_code / pwsh quick rules]",
  // ">",
  // "- pwsh result: stdout/stderr are OBJECTS, not strings — read .text (r.stdout?.text ?? \"\"), never concatenate them directly.",
  // "- Encoding: do not read UTF-8 files with Get-Content (CJK becomes mojibake) — use the read tool.",
  // "- PowerShell JSON: ConvertTo-Json flattens single-element arrays to a bare string (use -AsArray or build the JSON manually); Set-Content -Encoding UTF8 adds a BOM that breaks JSON.parse (strip /^\uFEFF/ or write with node).",
  // "- Generated code strings: no nested backticks/template literals inside run_code — use single-quoted strings.",
  "<",
].join("\n");

/** 第二轮对模型的提示默认文本（统一消息格式，仅第二轮出现一次；We need 风格）。 */
const DEFAULT_ROUND_TWO_INSTRUCTION = [
  "[round-minimal Second Round Reminder]",
  ">",
  "We can start executing the task.",
  "<",
].join("\n");

/** 设置 schema（同时驱动设置页 UI）。 */
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  firstRoundTools: z.array(z.string()).default([...DEFAULT_FIRST_ROUND_TOOLS]),
  roundOneInstruction: z.string().default(DEFAULT_ROUND_ONE_INSTRUCTION),
  roundTwoInstruction: z.string().default(DEFAULT_ROUND_TWO_INSTRUCTION),
  includeSubagents: z.boolean().default(false),
  showPolicy: z.boolean().default(true),
});

/** 归一化任意来源（组合行 config / settings 解析值）的配置。 */
function normalizeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const tools = Array.isArray(value.firstRoundTools)
    ? value.firstRoundTools
        .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
        .map((tool) => tool.trim())
    : [...DEFAULT_FIRST_ROUND_TOOLS];
  return {
    enabled: value.enabled !== false,
    firstRoundTools: tools,
    roundOneInstruction:
      typeof value.roundOneInstruction === "string" && value.roundOneInstruction.trim().length > 0
        ? value.roundOneInstruction.trim()
        : DEFAULT_ROUND_ONE_INSTRUCTION,
    roundTwoInstruction:
      typeof value.roundTwoInstruction === "string" && value.roundTwoInstruction.trim().length > 0
        ? value.roundTwoInstruction.trim()
        : DEFAULT_ROUND_TWO_INSTRUCTION,
    includeSubagents: value.includeSubagents === true,
    showPolicy: value.showPolicy !== false,
  };
}

/** 读取代理当前轮次：会话日志中最近一个 turn/start 的 data.turn；无则 0。 */
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

/** 是否为会话型子代理（含 workflow / ralph 派生的子会话）。 */
function isSubagent(agent) {
  try {
    const depth = agent?.options?.subagentDepth;
    if (typeof depth === "number" && depth > 0) return true;
    const events = agent?.session?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event !== null && typeof event === "object" && event.type === "subagent/descriptor") return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 该代理此刻是否处于首轮极简模式（enabled、非子代理（按配置）、turn === 1）。 */
function isFirstRound(source, agent) {
  const current = source();
  if (current.enabled !== true) return false;
  if (agent === null || typeof agent !== "object") return false;
  if (current.includeSubagents !== true && isSubagent(agent)) return false;
  return currentTurnOf(agent) === 1;
}

export default {
  name: "round-minimal",
  // systemPrompt：注册首轮提示段 + 监听组装瀑布；tools：监听执行前闸门。
  inject: ["systemPrompt", "tools"],
  apply(ctx, config = {}) {
    // 组合行 config 作为 base 层；settings.yaml 用户层优先（热重载）。
    // 注意：installSettingsSection 传给 setSource 的是"取值 thunk"（() => scope.get()），
    // 必须先调用拿到解析后的值再归一化，否则 normalizeConfig 会因入参是函数而
    // 回退到默认值，导致 settings.yaml 里的 enabled 等配置全部失效。
    const entry = normalizeConfig(config);
    let source = () => entry;
    installSettingsSection(ctx, NAMESPACE, SETTINGS_SCHEMA, entry, {
      setSource: (current) => {
        source = () => normalizeConfig(current());
      },
      onChange: () => {
        const live = source();
        ctx.logger.info(
          `[round-minimal] 配置已热更新：enabled=${live.enabled}, ` +
            `firstRoundTools=[${live.firstRoundTools.join(", ")}], ` +
            `includeSubagents=${live.includeSubagents}, showPolicy=${live.showPolicy}`,
        );
      },
    });

    const initial = source();
    ctx.logger.info(
      `[round-minimal] 已加载：enabled=${initial.enabled}, ` +
        `firstRoundTools=[${initial.firstRoundTools.join(", ")}], ` +
        `includeSubagents=${initial.includeSubagents}`,
    );

    // settings 服务惰性获取（apply 阶段可能尚未挂载，调用时再解析）。
    const getSettings = () => ctx.get("settings");

    /** 存在且启用 task-master-whiteboard 时返回其白板工具；否则空数组。 */
    function whiteboardToolsOf() {
      try {
        const settings = getSettings();
        if (settings === undefined || settings === null) return [];
        const wb = settings.get(WHITEBOARD_NAMESPACE);
        if (wb === undefined || wb === null || typeof wb !== "object" || wb.enabled === false) return [];
        return [...WHITEBOARD_TOOLS];
      } catch {
        return [];
      }
    }

    /** 首轮有效工具集 = 配置 firstRoundTools ∪ 白板工具（去重，配置顺序在前）。 */
    function effectiveFirstRoundTools() {
      const current = source();
      const base = Array.isArray(current.firstRoundTools) ? current.firstRoundTools : [];
      return [...new Set([...base, ...whiteboardToolsOf()])];
    }

    /** 尝试把本插件给模型发送的信息上报给 round-display 显示插件（best-effort）。
     *  服务不存在时静默跳过，不影响主流程。 */
    function reportRoundDisplay(agent, content) {
      try {
        const rd = ctx.get("roundDisplay");
        if (rd !== undefined && rd !== null && typeof rd.report === "function" && typeof content === "string" && content.trim().length > 0) {
          rd.report({ agent, plugin: "round-minimal", title: "policy", content });
        }
      } catch (error) {
        ctx.logger.debug(`[round-minimal] 上报 round-display 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // -----------------------------------------------------------------------
    // 对外信号：roundMinimal 服务（供 kaz-mode 等同步查询首轮极简状态）+
    // round-minimal/state 事件（状态变化时推送，供状态报告与日志）。
    // -----------------------------------------------------------------------
    const roundMinimalService = {
      version: 1,
      enabled: () => source().enabled === true,
      firstRoundTools: () => effectiveFirstRoundTools(),
      isMinimal: (agent) => isFirstRound(source, agent),
      turnOf: (agent) => currentTurnOf(agent),
    };
    ctx.effect(() => {
      const disposeService = ctx.provide("roundMinimal", roundMinimalService);
      return () => {
        if (typeof disposeService === "function") disposeService();
      };
    }, "round-minimal: 发布 roundMinimal 首轮状态服务");

    const lastMinimalState = new WeakMap();
    /** 状态变化时推送一次 round-minimal/state 信号；失败不影响主流程。 */
    function signalState(agent) {
      try {
        const minimal = isFirstRound(source, agent);
        if (lastMinimalState.get(agent) === minimal) return;
        lastMinimalState.set(agent, minimal);
        ctx.emit("round-minimal/state", {
          agent,
          minimal,
          turn: currentTurnOf(agent),
          firstRoundTools: effectiveFirstRoundTools(),
        });
      } catch {
        // 信号发送失败不影响首轮极简主流程
      }
    }

    // -----------------------------------------------------------------------
    // 1) 轮次提示段：首轮输出"首轮提示"、第二轮输出"第二轮提示"、第三轮起
    //    输出空串（空段在渲染时被丢弃，不进入提示词）。子代理按配置排除。
    // -----------------------------------------------------------------------
    ctx.systemPrompt.section({
      name: "round-minimal:policy",
      order: 200,
      text: (context) => {
        const current = source();
        if (current.enabled !== true) return "";
        if (current.showPolicy !== true) return "";
        const agent = context?.agent;
        if (agent === null || typeof agent !== "object") return "";
        if (current.includeSubagents !== true && isSubagent(agent)) return "";
        const turn = currentTurnOf(agent);
        let output = "";
        if (turn === 1) output = current.roundOneInstruction;
        else if (turn === 2) output = current.roundTwoInstruction;
        // 告诉 round-display 显示插件本轮发送了什么（best-effort）。
        reportRoundDisplay(agent, output);
        return output;
      },
    });

    /** 该代理是否呈现为 Code Mode（code-collapse 的 presentAs('code') 生效）。
     *  Code Mode 下工具面折叠为 run_code，pwsh / str_replace_editor 不再是独立
     *  schema（折叠进 run_code 的 SDK），首轮极简必须放行 run_code，否则首轮
     *  工具面为空。运行时检测（而非配置耦合）：code-collapse 未启用或声明
     *  失败时返回 false，首轮保持原生极简。 */
    function isCodeMode(agent) {
      try {
        const toolsSvc = ctx.get("tools");
        if (toolsSvc !== undefined && toolsSvc !== null && typeof toolsSvc.modeFor === "function") {
          return toolsSvc.modeFor(agent) === "code";
        }
      } catch {
        return false;
      }
    }

    // -----------------------------------------------------------------------
    // 2) 组装层过滤：首轮只保留白名单工具及其 tool:* 指导段。
    //    host 平面的监听器无 scope 标签，对 agent 作用域的组装同样生效
    //    （dsh-scope 的事件分发向上冒泡到无标签监听器）。
    // -----------------------------------------------------------------------
    ctx.on("system-prompt/assemble", function (assembly, context, next) {
      const current = source();
      signalState(context?.agent);
      if (current.enabled === true && isFirstRound(source, context?.agent)) {
        const allow = new Set(effectiveFirstRoundTools());
        // code-collapse 联动：Code Mode 呈现时工具面折叠为 run_code（pwsh /
        // str_replace_editor 不再是独立 schema），首轮必须放行 run_code，
        // 否则首轮工具面为空；SDK 内的嵌套调用仍走 pre-execute，极简范围
        // 不变（只放行 firstRoundTools 内的工具）。
        if (isCodeMode(context?.agent)) allow.add("run_code");
        assembly.tools = assembly.tools.filter(
          (tool) => tool !== null && typeof tool === "object" && allow.has(tool.name),
        );
        assembly.sections = assembly.sections.filter((section) => {
          if (typeof section?.name !== "string" || !section.name.startsWith("tool:")) return true;
          return allow.has(section.name.slice("tool:".length));
        });
      }
      return next();
    });

    // -----------------------------------------------------------------------
    // 3) 执行层闸门：首轮调用白名单之外的工具一律拒绝。
    //    组装层已让模型看不到其它工具，这里是纵深防御：拦截任何绕道的调用
    //    （例如内部调度、遗留的并发调用），并给出明确的中文拒绝原因。
    // -----------------------------------------------------------------------
    ctx.on("tools/pre-execute", (exec, next) => {
      const current = source();
      signalState(exec?.agent);
      if (current.enabled === true && isFirstRound(source, exec?.agent)) {
        const name = exec?.name;
        const tools = effectiveFirstRoundTools();
        // code-collapse 联动：Code Mode 呈现时放行 run_code（首轮唯一入口；
        // 其 SDK 内的嵌套调用仍按 effectiveFirstRoundTools 逐个过滤）。
        if (
          typeof name === "string" &&
          !tools.includes(name) &&
          !(name === "run_code" && isCodeMode(exec?.agent))
        ) {
          ctx.logger.info(
            `[round-minimal] 首轮拒绝调用工具 "${name}"（极简模式仅允许：${tools.join(", ")}）`,
          );
          return {
            kind: "deny",
            reason:
              `工具 "${name}" 在首轮（round-minimal 极简模式）不可用，本轮仅允许：` +
              `${tools.join(", ")}。首轮对话仅了解任务详情，` +
              `从第二轮开始即可使用全部工具。`,
          };
        }
      }
      return next();
    });
  },
};
