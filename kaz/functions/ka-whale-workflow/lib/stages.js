// ka-whale-workflow —— 阶段定义与注入文本（《Kaz8.0设计.md》§5.1）。
// 注入 = `[ka-whale-workflow <stage>]` 头部 + `canAdvance:[可跳转阶段]` 一行 + 正文。
// 正文一律英文（模型面文案），逐字来自设计稿。

export const STAGES = Object.freeze(["idle", "arrange_agent", "self-check"]);

export const STAGE_BODIES = Object.freeze({
  idle:
    "On each user message, first judge the work: is it one self-contained step that only we can do (talking to the user, the final integration, a decision), or does it contain any part with its own goal that can be verified on its own? Work with parts goes to arrange_agent and gets dispatched; work without parts we finish ourselves. Delegation is judged every round, not remembered from last round. Dispatch what can run in parallel in one round rather than one after another — but keep at most five subagents **running** at the same time: queue the rest and dispatch them as the running ones report back. Whenever there is experience worth keeping — not only inside a report — go to arrange_agent and dispatch a memoryMaintainer to record it; memory bookkeeping stays internal and is never narrated to the user. Subagent reports come to you automatically — handle them before moving on. To see the arrangement as it is, use get_arrangement; to change it, use whale_report to jump to arrange_agent.",
  arrange_agent:
    "Arrangement stage: use write_arrangement to record this round's dispatch plan (persona / blacklist / task / fork). The arrangement must contain memoryMaintainer — only it can write memories. When done, use whale_report to return to idle, then dispatch item by item — everything that can run in parallel goes out in the same round, up to five subagents running at once, with the rest queued until the running ones report back.",
  "self-check":
    "Self-check stage. While we are here, whale_report is the only tool that works — anything else fails. Its `reflection` argument is required here: write the self-check into it, at most 1024 bytes. These findings are not a deliverable: they are not reported to the user, and they do not go into anyone's closing message. Answer them for ourselves, briefly and honestly — Have we kept to the system prompt and to what the injected context tells us? Have we loaded the skills this situation actually needs? Have we arranged subagents where that would work better? Once back in idle, should we fold noise away with context_compress or delete? What have we got wrong? Where do we actually stand? What do we do next? Then report the stage those answers point to.",
});

/**
 * 可跳转关系（§5.1 表格的"可跳转"列）。
 *
 * **self-check 不在任何阶段的"可跳转"里**（所有者 2026-09-14 定案）：它是**程序自动进入**的
 * 阶段——第 4n 轮由 index.js 直接 setStage，不走 whale_report。所以：
 *   * 模型**不能**用 whale_report 主动进 self-check（`idle` 的可跳转只有 arrange_agent）；
 *   * 但**必须能出来**（whale_report 从 self-check 回 idle / arrange_agent），否则就锁死了。
 * 把 self-check 写进某个阶段的跳转表等于把这条自动流程交回给模型，与设计相反。
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  idle: Object.freeze(["arrange_agent"]),
  arrange_agent: Object.freeze(["idle"]),
  "self-check": Object.freeze(["idle", "arrange_agent"]),
});

/** 注入头。 */
export function stageHeader(stage) {
  return `[ka-whale-workflow ${stage}]`;
}

/**
 * self-check 阶段唯一可用的工具。
 *
 * 这条不是建议而是实现：kaz-shared 在每次 system-prompt 装配时读当前阶段，
 * 处于 self-check 时把工具面收成这一个（见 kaz-shared/lib/index.js）。
 * 名字定义在这里，因为它属于阶段定义。
 */
export const SELF_CHECK_ONLY_TOOL = "whale_report";

/**
 * 反思文本的门禁（字节）。
 *
 * **刻意设计**：公布值 1024、真实门禁 2048（正好两倍），报错文案只报公布值。
 * 与记忆三件（ka-whale-memory）同一套思路，但那边是 ×1.2 的缓冲垫、这边是 ×2——
 * 因为这段反思是**强制**写的，写的人没有"改短再试"的余地，容错要更宽；
 * 而对外口径仍压着 1024，否则"简短反思"会自然长成一篇报告。
 */
export const REFLECTION_ADVERTISED_BYTES = 1024;
export const REFLECTION_GATE_BYTES = 2048;

const utf8Encoder = new TextEncoder();

/** 文本的 UTF-8 字节数（非字符串按空串计）。 */
export function byteSizeOf(value) {
  return utf8Encoder.encode(typeof value === "string" ? value : "").length;
}

/**
 * 反思文本是否合格。不合格返回英文拒绝原因，合格返回 null。
 *
 * 原因里的数字是**公布值**（1024）而不是真实门禁（2048），与记忆三件一致：
 * 报出来的数必须与工具描述里的数一致。
 * @param {unknown} value - 模型传来的 reflection。
 * @returns {string|null} 拒绝原因或 null。
 */
export function reflectionProblem(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    return "reflection is required while the stage is self-check — say briefly what you checked and where you are going";
  }
  const size = byteSizeOf(value);
  if (size > REFLECTION_GATE_BYTES) {
    return `reflection is ${size} bytes (limit ${REFLECTION_ADVERTISED_BYTES}) — shorten it`;
  }
  return null;
}

/**
 * 第几次用户消息该自动进 self-check。4 的倍数的轮次（第 4、8、12…）自检一次。
 * 从**本次部署之后**第一条用户消息开始数（见 ka-whale-workflow/lib/index.js 的计数）。
 */
export const SELF_CHECK_EVERY = 4;

/**
 * 这一轮该不该在 idle 之前先进 self-check。
 * @param {number} rounds - 自本次部署以来见过的用户消息条数（本轮已计入）。
 * @returns {boolean} 是否进入。
 */
export function shouldEnterSelfCheck(rounds) {
  return Number.isFinite(rounds) && rounds > 0 && rounds % SELF_CHECK_EVERY === 0;
}

/** 记忆提示的注入头（与阶段注入分开：只在"连续侦察够久又没去派发"时出现）。 */
export const MEMORY_HINT_HEADER = "[ka-whale-workflow memory_hint]";

/** 记忆提示正文（模型面文案，英文）。 */
export const MEMORY_HINT_BODY = "Do we need to save memory?";

/**
 * 记忆提示的完整注入文本：头部 + 正文。
 * 触发条件见 kaz-shared/lib/memory-hint.js（连续调用观察工具集达阈值且仍在 idle）。
 * @returns {string} 注入文本。
 */
export function renderMemoryHintText() {
  return [MEMORY_HINT_HEADER, MEMORY_HINT_BODY].join("\n");
}

/** "自己动手造东西"提示的注入头（与阶段注入、记忆提示分开的第二类提示）。 */
export const BUILDING_HINT_HEADER = "[ka-whale-workflow building-hint]";

/**
 * 路径占位符。
 *
 * 与 `ELAPSED_PLACEHOLDER` 同一个道理：路径只有**注入那一刻**才知道（而且不一定知道），
 * 所以正文先写成模板、渲染时替换。做成导出常量是为了让"替换得对不对"能被直接比对。
 */
export const BUILDING_HINT_PATH_PLACEHOLDER = "{{path}}";

/**
 * "自己动手造东西"提示正文（模型面文案，英文）。
 *
 * 为什么开头是一句**陈述**而不是问句（与 DIVING_HINT_CHECKS 那套相反）：这条提示要说的
 * 首先是一个模型自己看不见的事实——它刚用自己的手写了文件，而这一轮什么都没安排。
 * 事实摆出来，后面那个"该不该由我亲手造"才有由头。
 *
 * 三条排除项**逐字取自技能自己的 description**（skills/building-something-new）：修一个
 * 坏掉的东西、执行一份已经谈定的计划、把一个已有的东西搬过去——都不是这个技能的地盘。
 * 不写这三条的话，这条提示会在相邻三个技能上误开，而"误开的提示会被学会无视"是这套
 * 提示系统唯一的失败模式。
 *
 * 最后那句讲的是**角色名**：`ka_sub_whale` 按名字复用子代理，所以"proposer-a / proposer-b"
 * 这种**固定的一对**在第二轮拿回来的还是同一只手、还揣着上一轮的立场——两只手会并成一只手。
 * 名字要跟着本轮真正在争的两个方向走。
 */
const BUILDING_HINT_BODY_TEMPLATE = `You have just written ${BUILDING_HINT_PATH_PLACEHOLDER} with your own hands, and nothing this round was arranged around it. If that file is a fix for something broken, a plan someone already agreed on, or an existing thing being ported, this does not apply — carry on. If it is something that does not exist yet, read building-something-new before the next write and take the round through arrange_agent: name the two hands after the directions they argue rather than a standing pair, because the same name reaches the same child, still holding its old argument — and put their disagreement in the direction each one argues, not in the wording of the task.`;

/**
 * 路径未知时的说法。
 *
 * **宁可模糊，也不能把 `undefined` 填进提示里**（与 `elapsedCheck` 同一条理由）：
 * 那句话是给模型读的，一个 `undefined` 会让整条提示显得像坏掉了，
 * 而它本该传达的"停一下，看看这件事该不该由你做"就丢了。
 *
 * 措辞必须能直接连读：它填进的是 "You have just written ___ with your own hands" 的空位，
 * 所以不能写成名词短语（写成 "the file you just wrote" 就变成
 * "written the file you just wrote"，读起来像故障）。
 */
const BUILDING_HINT_PATH_FALLBACK = "a file";

/**
 * 渲染"自己动手造东西"提示的正文。
 * @param {string|undefined} path - 刚写过的文件路径；未知时 undefined。
 * @returns {string} 正文。
 */
export function buildingHintBody(path) {
  const text = typeof path === "string" && path.trim().length > 0 ? path : BUILDING_HINT_PATH_FALLBACK;
  return BUILDING_HINT_BODY_TEMPLATE.replace(BUILDING_HINT_PATH_PLACEHOLDER, text);
}

/**
 * "自己动手造东西"提示的完整注入文本：头部 + 正文。
 * 触发条件见 kaz-shared/lib/building-hint.js（自己的手成功写过文件、且本轮什么都没安排）。
 * @param {string|undefined} path - 刚写过的文件路径；未知时 undefined。
 * @returns {string} 注入文本。
 */
export function renderBuildingHintText(path) {
  return [BUILDING_HINT_HEADER, buildingHintBody(path)].join("\n");
}

/** "刹车"提示的注入头：一轮里工具调用太多时出现（见 kaz-shared/lib/diving-hint.js）。 */
export const DIVING_HINT_HEADER = "[ka-whale-workflow diving-hint]";

/**
 * 唯一一条**每轮都不一样**的文案占位符。
 *
 * 清单本身是冻结字面量，而"已经耗了多久"必须在**注入那一刻**才知道，所以那条先写成模板、
 * 由 `elapsedCheck()` 在渲染时替换。占位符做成导出常量是为了让"替换得对不对"能被直接比对
 * （误写一个字符就会原样漏进提示，而漏一个占位符是**看不出来**的）。
 */
export const ELAPSED_PLACEHOLDER = "{{elapsed}}";

/** "已经耗了多久"那一条的模板，排在清单**最前面**（它的位置由 `elapsedFirst()` 认，不靠下标）。 */
const ELAPSED_STATEMENT_TEMPLATE = `This round has been running for ${ELAPSED_PLACEHOLDER}.`;

/**
 * "刹车"提示的检查清单。每轮工具调用到阈值时注入，用来把"还在埋头做"拉回"该不该停"。
 *
 * 第 1 条是**陈述句**（"这一轮已经跑了 23 分钟"），刻意排在最前面：它报的是一个模型自己
 * 看不见的事实——它数得清自己调了多少次工具，却感觉不到过了多久，而"拖太久"正是这条提示
 * 要拦的东西。把事实摆在开头，后面那串问句才有由头，读起来也才像一段话。
 *
 * 其余几条之所以是问句而不是命令：它们要能在**任何**处境下被读一遍，
 * 而大部分处境下答案都是"否"。写成命令（"停下来汇报"）就会在不需要停的时候也叫停，
 * 提示本身变成噪音；写成问句，只有真出问题时才起作用。
 *
 * **位置只由这张清单决定**：所有输出都从它派生（见 elapsedFirst / remainingChecks），
 * 角色提问则统一挂在耗时那句之后。所以调整顺序 = 挪这里的行，不用去改任何下标。
 */
export const DIVING_HINT_CHECKS = Object.freeze([
  ELAPSED_STATEMENT_TEMPLATE,
  "Have we encountered any unsolvable problems?",
  "Have we been on the same step for too many rounds?",
  "Do we need to load any skills?",
  "Do we need to compress or fold some context to reduce noise?",
  "Are we on the wrong track and need to rethink entirely?",
]);

/**
 * 把耗时填进模板，得到那一条陈述句。
 *
 * **起点未知**（拿不到本轮那条用户消息的时刻）时说的是"不知道，但已经拖了很久"：
 * 宁可给出一个诚实的模糊说法，也不能把 `undefined` 填进提示里——那句话是给模型读的，
 * 一个 `undefined` 会让整条提示显得像坏掉了，而它本该传达的"停下来看看"就丢了。
 *
 * 模板里找不到占位符时**原样返回文本**：宁可漏一个数字，也不能把一句话悄悄抹掉。
 * @param {string|undefined} elapsed - 已格式化好的时长（如 "23 minutes"），未知时 undefined。
 * @returns {string} 填好的句子。
 */
function elapsedCheck(elapsed) {
  const text = typeof elapsed === "string" && elapsed.trim().length > 0 ? elapsed : "a while now";
  return ELAPSED_STATEMENT_TEMPLATE.replace(ELAPSED_PLACEHOLDER, text);
}

/** 填好的耗时陈述句（正文的第一句）。 */
function elapsedFirst(elapsed) {
  return elapsedCheck(elapsed);
}

/**
 * 除耗时那句之外的全部检查项（按清单顺序）。
 *
 * 靠**认出那条模板**把它取出来，而不是靠某个下标：下标会随清单增删而错位，
 * 而这类错位不会报错，只会悄悄少一句或多一句（原先那个 `ROLE_QUESTIONS_AT` 就是这个隐患）。
 */
function remainingChecks() {
  return DIVING_HINT_CHECKS.filter((item) => item !== ELAPSED_STATEMENT_TEMPLATE);
}

/**
 * 主代理独有的两条提问：汇报对象是**用户**（主代理是对话的对外一侧），
 * "该不该派子代理"是主代理独有的杠杆，子代理没有派发权。
 */
function roleQuestionsForMain() {
  return ["Do we need to report to the users?", "Should we arrange some subagents?"];
}

/**
 * 子代理版换的两处：汇报对象是**主代理**（子代理不对用户说话），并明说 hand back——
 * 子代理一交回就结束，没有后续；没有"派子代理"这一问（子代理无派发权），换成**升级**，
 * 把"该不该拆、该不该请主代理加人"提出来交给主代理决定。
 */
function roleQuestionsForSubagent() {
  return [
    "Do we need to report to the main agent and hand back?",
    "Is the task too much for one agent, should it be split, or should we ask the main agent for more subagents?",
  ];
}

/**
 * 正文的通用组装：**耗时那句在最前** + 角色提问 + 剩下的检查项。
 * 两个版本共用这一段，所以两者的差别只剩 `questions` 一处。
 * @param {string|undefined} elapsed - 已格式化好的本轮耗时；省略时按"未知"渲染。
 * @param {string} questions - 该角色自己那两条提问（已拼成一句）。
 * @returns {string} 正文。
 */
function composeDivingHintBody(elapsed, questions) {
  return [elapsedFirst(elapsed), questions, remainingChecks().join(" ")].join(" ");
}

/**
 * "刹车"提示正文（主代理版，模型面文案，英文）。
 * @param {string} elapsed - 已格式化好的本轮耗时；省略时按"未知"渲染。
 * @returns {string} 正文。
 */
export function divingHintBody(elapsed) {
  return composeDivingHintBody(elapsed, roleQuestionsForMain().join(" "));
}

/**
 * "刹车"提示正文（子代理版）。
 * @param {string} elapsed - 已格式化好的本轮耗时；省略时按"未知"渲染。
 * @returns {string} 正文。
 */
export function divingHintBodyForSubagent(elapsed) {
  return composeDivingHintBody(elapsed, roleQuestionsForSubagent().join(" "));
}

/**
 * "刹车"提示的完整注入文本：头部 + 正文。
 * 触发点：一轮内第 32 次工具调用，之后每再满 16 次。
 * @param {string} elapsed - 已格式化好的本轮耗时；省略时按"未知"渲染。
 * @returns {string} 注入文本。
 */
export function renderDivingHintText(elapsed) {
  return [DIVING_HINT_HEADER, divingHintBody(elapsed)].join("\n");
}

/**
 * 子代理版刹车提示的完整注入文本。
 *
 * 注入头与主代理版**相同**（所有者定案）：两者在日志里都归为 diving-hint 一类，
 * 靠正文里的措辞区分角色，不靠头。
 * @param {string} elapsed - 已格式化好的本轮耗时；省略时按"未知"渲染。
 * @returns {string} 注入文本。
 */
export function renderDivingHintTextForSubagent(elapsed) {
  return [DIVING_HINT_HEADER, divingHintBodyForSubagent(elapsed)].join("\n");
}

/** 合法跳转行（§5.1 表格的"可跳转"列，模型可见）。 */
export function stageAdvanceLine(stage) {
  const targets = LEGAL_TRANSITIONS[stage] ?? [];
  return `canAdvance:[${targets.join(", ")}]`;
}

/**
 * 组装某一阶段的注入文本：头部 + canAdvance 行 + 正文。
 * @param {string} stage - 阶段名。
 * @returns {string} 注入文本。
 */
export function renderStageText(stage) {
  const body = STAGE_BODIES[stage] ?? STAGE_BODIES.idle;
  return [stageHeader(stage), stageAdvanceLine(stage), body].join("\n");
}
