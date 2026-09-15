// kaz-context-policy —— 上下文压缩提醒（§四）。
//
// 形态：一条 plugin 消息（**上下文注入**，不是系统提示段）。注意它会**落进会话表面节点**
//       （dsh-agent-loop 的 `session.append("user/message", …, { surfaceOp: "append" })`），
//       所以每一条提示都会在后续每个请求里重复出现，直到被压缩掉——提示发得越密，代价越高。
// 时机：占用 ≥50% 后开始提醒；之后每再涨 ≥5 个百分点就再提醒一次。回落到 50% 以下即清空
//       状态，之后再涨到 50% 以上会重新从第一次的措辞开始。每个 step 检查一次
//       （`agent/pre-step` 按模型步派发，即一轮里每次工具调用一次）。
//
// 反"被当噪音"的三条设计（依据：一次真实事故——同一条恒定措辞重复 4 次，全部被忽略）：
//   1) **带增量**：重复提醒会写明"比上次提醒时又涨了 N 个点"，让它是新信息而不是回声。
//   2) **带升级**：第 3 次起换标题与措辞（ACTION REQUIRED、要求先压缩再继续），
//      不再和第一次长得一样。
//   3) **消解顾虑**：明说"压缩已收尾的旧中段不影响眼前任务"——把"会不会丢正在用的东西"
//      这个最常见的拖延理由直接堵掉。
//   （曾试过"被忽略后把门槛降到 2 点"来加强提醒，实测正好相反：它让提示更频繁、更像噪音，
//     已移除。降噪的方向是**更少但更有信息量**，不是更密。）
//
// 状态机的要害（2026-09-13 修，五轮，每轮都是"独立验证把上一轮掀翻"）：
//   **"刚压过"是一次性事件；要够幅度才算数；压缩之后要真的涨回原水平才认下一次；
//     相邻两步不发两条；升级整期只给一个名额。**
//   ① 原先把 `compressed` 当状态存进 hintState，并在静默分支里原样保留，于是只要压过一次，
//      之后占用 ≥50% 的**每一步**都满足 `compressed`，提示变成"每个工具调用一条"——用户报的就是这个
//      （实测 8 步 7 条，其中 6 条复读同一句 "compression did work"）。
//   ② 第一版改成一次性 + "入带最低点"判据：最低点只往下走，大压缩留下的落差会永远满足判据，
//      下一次正常增长的提示会重新点亮它，再下一步就冒充"刚压过"（假阳性，不连续）。
//   ③ 第二版改成"单步内相对高点跌 ≥`HINT_COMPRESSED_DROP_PERCENT` 点"，并把升级收敛成
//      "每期一个名额 + 冷却"；但基准里含"只往下走的 lowPercent"，加上 5 点增长条款，
//      **来回震荡的占用（70↔55、50↔60）仍然每步一条**——同一个症状换了个形状。
//   ④ 第三/四版：基准换成 `lastCompressHigh`；相邻判断改了一个**会重置的计数器**（用每期归零的
//      `checks` 判断会在跨期那一步失效）；"被忽略的要求"与"发过几条通知"拆成两个计数。
//   ⑤ 现在（本版）：重新武装要求**严格涨回 `lastCompressHigh` 本身**（不留空档，空档会被
//      61→52 这种半程回落卡在边界上）；跌破阈值那条路也要跌满 10 点才算压缩（±1 点抖动
//      不该被叙述成一次压缩）；反馈文案把"自上次压缩以来的降幅"与"相对上一次检查的步差"分开写。
//   验收（10 个脚本化序列 + 500 次随机 40 步行走，见
//   `不入库文件\kaz-hint-probe-20260913\hint-regression.mjs` 与 `adversarial.mjs`）：
//   用户报的形状 7/8 → 3/8（其中一条是"停留过久"升级），震荡形状降到"每两/三步一条"，
//   随机行走 20000 步里零相邻通知、零高于 50% 的密度。
//
// 数据：contextPressure 投影（pressureTokens = 最近一次请求的占用；contextWindow = 窗口）。

import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** 注入阈值：占用达到窗口的这个百分比就开始提醒。 */
export const HINT_THRESHOLD_PERCENT = 50;

/** 触发步长：比上次提醒时又涨这么多就再提醒。 */
export const HINT_STEP_PERCENT = 5;

/** 建议目标：压到窗口的这个百分比以下。 */
export const HINT_TARGET_PERCENT = 35;

/** 第几次起换措辞（升级为 ACTION REQUIRED）。 */
export const HINT_ESCALATE_AT = 3;

/** 在阈值带内停留多少个检查（工具步）仍未压，就直接升级——治"压一点又涨回来"的循环。 */
export const HINT_ESCALATE_AFTER_CHECKS = 6;

/** "停留过久"升级与上一条提示之间至少要隔这么多次检查——不让两条升级挤在一起。 */
export const HINT_ESCALATE_SPACING_CHECKS = 3;

/**
 * 阈值带内（或跌破阈值时）相对"上次见到的高点"至少跌这么多点，才认定为一次**压缩事件**。
 * 用途有两个：判定"压过了但不够"的反馈口径，以及把"跌破一点点"这类计量噪声排除掉。
 */
export const HINT_COMPRESSED_DROP_PERCENT = 10;

/**
 * 每个对话的提醒状态。回落阈值以下就转移到"刚压过"的形态。字段：
 *   `percent` —— **上次发出通知时**的占用（不是上次检查时的占用）；
 *   `count` —— 本窗口已发出的通知条数（含压缩反馈）；
 *   `demands` —— 已发出而未被理会的"要求压缩"通知条数（压缩反馈不计入）；
 *   `checks` —— 本期经过的检查次数（压缩后从 0 重新计）；
 *   `lastStepHadHint` —— 上一次进入本插件的检查有没有发通知（判"相邻两步不发两条"）；
 *   `escalatedInStay` / `escalatedAtChecks` —— 本期的升级名额与上次升级的步号（冷却）；
 *   `pendingCompress` —— 已发生一次压缩、还没报道过的降幅（点；发一条通知即清）；
 *   `lowPercent` —— 本停留期见过的最低占用；
 *   `lastCompressHigh` —— 重新武装的基准水位（压缩后压低，涨回原水平才抬高）。
 */
const hintState = new Map();

/** 只读：取某会话当前的提醒状态（供测试/诊断，不改变行为）。 */
export function peekHintState(sessionId) {
  return hintState.get(sessionId);
}

/** 读上下文占用；拿不到就返回 null。 */
export function readPressure(ctx, session) {
  if (session === undefined || session === null) return null;
  try {
    const projections = ctx.get("sessionProjections");
    if (projections === undefined || typeof projections.snapshot !== "function") return null;
    const value = projections.snapshot(session, ["contextPressure"])?.values?.contextPressure;
    if (value === undefined || value === null) return null;
    const contextWindow = value.contextWindow;
    const used = typeof value.projectedTokens === "number" ? value.projectedTokens : value.pressureTokens;
    if (typeof contextWindow !== "number" || contextWindow <= 0 || typeof used !== "number" || used < 0) return null;
    return { percent: Math.round((used / contextWindow) * 100), used, window: contextWindow };
  } catch {
    return null;
  }
}

/** 建议至少压掉多少 token：当前占用 − 35%×窗口。 */
export function hintNeedTokens(pressure) {
  const need = Math.ceil(pressure.used - (HINT_TARGET_PERCENT / 100) * pressure.window);
  return need > 0 ? need : 0;
}

/**
 * 达到阈值时的提醒原文（英文）；未达阈值返回空串。
 * @param {object} ctx - 插件上下文（读投影）。
 * @param {object} session - 会话。
 * @param {object} [state] - 该会话的提醒状态（字段见 hintState 的说明）。
 * @param {{compressed?: boolean, fell?: number, escalated?: boolean, staleBand?: boolean,
 *   checks?: number}} [options] -
 *   `compressed`=本次提醒按"压了但不够"的口径说话（由门控判定为一次压缩事件，
 *   此处**不**从"占用比上次低"顺手推断——占用每步都在抖，那是抖动，不是压缩）；
 *   `fell`=该次压缩事件相对**上次压缩时的水平**（`lastCompressHigh`，不是会话历史峰值）的降幅（点），
 *   `stepFell`=相对**上一次检查**的实测步差
 *   （两者不一致时会分别写明，免得把阶梯式下跌的步差说成整段降幅）；
 *   `escalated`=本次用升级措辞（**由门控决定**，此处不重新推导，免得两处判断分叉）；
 *   `staleBand`=本次升级走的是"停留过久"那条路（决定文案里陈述"涨了多少"还是"待了多久"）；
 *   `checks`=在阈值带内已停留的检查次数（工具步数）；
 *   `ignored`=已发出而未被理会的"要求压缩"通知条数（压缩反馈不计入）。
 */
export function hintText(ctx, session, state, options) {
  const pressure = readPressure(ctx, session);
  if (pressure === null || pressure.percent < HINT_THRESHOLD_PERCENT) return "";
  const need = hintNeedTokens(pressure);
  const count = typeof state?.count === "number" ? state.count : 0;
  const previous = typeof state?.percent === "number" ? state.percent : undefined;
  const grew = previous === undefined ? undefined : pressure.percent - previous;
  const checks = typeof options?.checks === "number" ? options.checks : 0;
  // 已发出、但没被理会的"要求压缩"通知条数（压缩反馈不算）——升级文案只用它。
  const ignored = typeof options?.ignored === "number" ? options.ignored : 0;
  const staleBand = options?.staleBand === true;
  const escalated = options?.escalated === true;
  // "压过了但不够"：只认门控给的判定，不再从"占用比上次低"顺手推断——占用每步都在抖，
  // 那是抖动，不是压缩。
  const underCompressed = options?.compressed === true;

  const head = escalated ? "[ka-context-policy compression-hint · ACTION REQUIRED]" : "[ka-context-policy compression-hint]";
  const lines = [head];

  if (grew === undefined) {
    lines.push(
      `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). Compress before continuing this task: pick an already-finished middle span and run context_compress with its from_seq and to_seq.`,
    );
  } else if (underCompressed) {
    // 关键反馈：上次压缩确实生效了，但幅度不够——明确说出来，并给出还差多少。
    // 降幅由门控传进来（它才是"这次事件跌了多少"的权威来源）。**两个口径要分开写**：
    // `fell` 是相对"上次压缩时的水平"算的（检测用的就是它；**不是**会话历史峰值——所以文案
    // 只能说 "since the last compression"），`stepFell` 是相对**上一次检查读数**的实测步差。
    // （由门控连同 `prevPercent` 一起给出——不能拿"上次通知时的占用"当上一步读数，
    //  那样两者永远相等、第二个数就永远不会被印出来）。
    const fell = typeof options?.fell === "number" ? options.fell : undefined;
    const prevPercent = typeof options?.prevPercent === "number" ? options.prevPercent : undefined;
    const stepFell =
      typeof options?.stepFell === "number"
        ? options.stepFell
        : prevPercent !== undefined && prevPercent > pressure.percent
          ? prevPercent - pressure.percent
          : grew !== undefined && grew < 0
            ? -grew
            : undefined;
    const movement =
      fell === undefined
        ? stepFell === undefined
          ? ""
          : ` — usage fell ${stepFell} point(s)`
        : stepFell === undefined || Math.abs(fell - stepFell) <= 2
          ? ` — usage fell ${fell} point(s)`
          : // 基准是"上次压缩时的水平"，不是会话历史峰值——措辞必须照实说，
            // 否则 70→65→60→55→50 这种阶梯下跌会被读成"从峰值只跌了 10 点"（真值 20）。
            // 括号里那个步差只在它是**正数**时才写：压缩反馈挂在增长步上时，步差会是负数，
            // "usage fell -3 point(s) in the last step" 读起来自相矛盾（验证者顺带指出）。
            stepFell > 0
            ? ` — usage fell ${fell} point(s) since the last compression (${stepFell} in the last step)`
            : ` — usage fell ${fell} point(s) since the last compression`;
    lines.push(
      `Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens). The compression since this reminder did work` +
        movement +
        `, but not enough: it is back above ${HINT_THRESHOLD_PERCENT}% and still ${need} tokens over the ${HINT_TARGET_PERCENT}% target.`,
    );
    lines.push(
      "Compress before continuing, and fold a larger span this time: pick the oldest spans whose work is already finished, not the smallest one that fits.",
    );
  } else {
    // "涨了多少"与"停留多久"两条升级路只陈述其一，避免同一条消息里两个理由打架。
    const delta =
      grew === undefined
        ? ""
        : staleBand
          ? `, and this band has now stayed above ${HINT_THRESHOLD_PERCENT}% for ${checks} step(s)`
          : ` — up ${grew} point(s) since this reminder was last given` +
            (escalated && ignored > 0 ? `, and ${ignored} such reminder(s) have gone unanswered` : "");
    lines.push(`Context usage is ${pressure.percent}% (${pressure.used} / ${pressure.window} tokens)${delta}.`);
    lines.push(
      escalated
        ? "Stop other work and compress before continuing: an already-finished middle span is safe to fold, and folding it does not disturb the task in front of you."
        : "Compress soon: fold an already-finished middle span (from_seq / to_seq). Folding old, settled work does not disturb the task in front of you.",
    );
  }

  lines.push(`Compressing at least ~${need} tokens brings usage under ${HINT_TARGET_PERCENT}%.`);
  return lines.join("\n");
}

/**
 * 注册上下文注入：每个 step（模型步）检查占用。提醒条件（任一满足）：
 *   * 首次越过 50%；或
 *   * 比上次提醒时又涨 ≥5 个点；或
 *   * 刚落下一道够幅度的跌幅——本步被判定为一次压缩（"压了但不够"的口径），一次事件一条；或
 *   * **在阈值带内已停留 ≥6 次检查**（治"压一点又涨回来"的循环，直接升级，本停留期只一次）。
 * 回落到 50% 以下清空计数，并把"压过"的事实带过阈值线（降幅不够则不认）。
 */
export function installHintInjection(ctx) {
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== "object" || decision.kind !== "enter") return decision;
    const agent = payload?.agent;
    if (agent === undefined || agent === null || typeof agent !== "object") return decision;
    const sessionId = agent.session?.id;
    const pressure = readPressure(ctx, agent.session);
    if (pressure === null) {
      // 这一步拿不到占用（投影缺失/异常）：本步**没有**发通知，所以"上一步发过没有"要清掉——
      // 否则下一步会以为与"上上次"相邻或不相邻，判断失真（验证者抓到的窄洞）。
      // 停留计数照常 +1：投影坏掉的那几步同样是"这一步过去了"，不数进来的话
      // 一次长时间投影故障之后，"停留过久"的升级会提前到来（验证者第五轮顺带指出）。
      if (typeof sessionId === "string") {
        const known = hintState.get(sessionId);
        if (known !== undefined) {
          hintState.set(sessionId, { ...known, lastStepHadHint: false, checks: (known.checks ?? 0) + 1 });
        }
      }
      return decision;
    }
    if (pressure.percent < HINT_THRESHOLD_PERCENT) {
      // 回落到阈值以下：计数清空，并把"刚压过"当作一次压缩事件带过阈值线（占用不会自己掉
      // 这么多，所以跌破阈值本身就是压缩的证据）。`drop` 一并记下，用来写降幅。
      // 但"跌破一点点"（抖动式的 1~2 点）不当压缩报道：要 ≥ 半个降幅门槛才算数。
      const previous = typeof sessionId === "string" ? hintState.get(sessionId) : undefined;
      if (typeof sessionId === "string") {
        if (previous !== undefined) {
          const high = Math.max(previous.percent, previous.lowPercent ?? previous.percent);
          const drop = high - pressure.percent;
          // 跨阈值这次事件要不要按"压了但不够"报道：同样要够 `HINT_COMPRESSED_DROP_PERCENT`。
          // 早先只要求"半个门槛"，结果 49↔51 这种 ±1 点抖动也被叙述成一次压缩（验证者抓到的第三处）。
          const qualifying = drop >= HINT_COMPRESSED_DROP_PERCENT;
          hintState.set(sessionId, {
            percent: pressure.percent,
            lowPercent: pressure.percent,
            prevPercent: pressure.percent,
            count: 0,
            checks: 0,
            demands: 0,
            // 本步（跨期那一步，在阈值带外）没有发通知，所以下一步的"相邻"是假。
            lastStepHadHint: false,
            // 新的一期：升级名额重新发放（升级是"你一直没压"，跌破阈值等于这一期结束）。
            escalatedInStay: false,
            // 压缩事件的"待报道"软标记 + 报道时要写的降幅，由跨阈值线后的**第一条**提示消费。
            pendingCompress: qualifying ? drop : undefined,
            // 刚压过：重新武装的基准压到当前水平。
            lastCompressHigh: pressure.percent,
          });
        } else {
          hintState.delete(sessionId);
        }
      }
      return decision;
    }
    const state = typeof sessionId === "string" ? hintState.get(sessionId) : undefined;
    // 上一步的读数：用来把"步差"算准（`state.percent` 是上次**发通知**时的口径，不能当步差基准）。
    const prevPercent = typeof state?.prevPercent === "number" ? state.prevPercent : undefined;
    // 带内跌幅：从"上一次压缩后的水平"（或本期的最高水位）算起。每次压缩都会把基准压低，
    // 所以必须等占用**重新涨回上一次压缩前的水平**，下一次下跌才可能算成新事件——
    // 否则 70↔55 这种来回震荡会把每一次下跌都当成新压缩，退化成每步一条（正是老 bug 的观感）。
    // 门槛取"回到原水平"而不是"回到原水平附近"：留一个 40% 的空档时，61→52 这种半程回落
    // 会正好卡在边界上，于是每一来回都算一次新事件（验证者第三轮给的边界反例）。
    const lastCompressHigh = typeof state?.lastCompressHigh === "number" ? state.lastCompressHigh : undefined;
    const bandHigh = Math.max(state?.percent ?? pressure.percent, lastCompressHigh ?? pressure.percent);
    const fellNow = bandHigh - pressure.percent;
    const dropNow = state !== undefined && fellNow >= HINT_COMPRESSED_DROP_PERCENT;
    // 一次压缩事件只报道一次：带内刚跌够（本步），或带着跨阈值时留下的待报道标记。
    // 标记只在**发出一条提示**时消费掉，所以它既不会重复，也不会在"没有提示要发"的那一瞬丢失。
    const pending = typeof state?.pendingCompress === "number" ? state.pendingCompress : undefined;
    const compressFell = dropNow ? fellNow : pending;
    const compressed = dropNow || pending !== undefined;
    // 计数分两个，别混：
    //   `count`    —— 这个窗口里已经发过几条通知（含压缩反馈），只用来陈述事实；
    //   `demands`  —— 有几条"要求你去压"的通知被忽略了。压缩反馈是**好消息**，不是新的要求，
    //                 所以它既不该涨 demands，也不该把 demands 清零后让下一条从 1 数起。
    const count = state?.count ?? 0;
    const demands = state?.demands ?? 0;
    // "在阈值带里待了多久"：每经过一次检查就 +1；压过就从 0 重新计。
    const checks = compressed ? 0 : (state?.checks ?? 0) + 1;
    // 两条通知不挤在相邻两步。判据直接就是"上一次进入本插件的检查有没有发通知"
    // （`lastStepHadHint`）：不要去比步号——步号要么被跨期重置、要么要跨期保留，
    // 两条路我都踩过（跨期第一步误判为不相邻 / 计数器错位后误判为相邻）。
    const stepGapOk = state?.lastStepHadHint !== true;
    // 升级：整条"停留期"里**只升级一次**（哪条路先到算哪条），然后在两条路之间留一段冷却。
    // 为什么两条路要共用一个名额：它们说的其实是同一句话（"你一直没压"）——"被忽略够多次"与
    // "停留够久"前后脚各发一条，读起来是同一个意思重复两遍。旧版那个标记只在升级时置位、
    // 且被压缩事件清零，于是"压一点又涨回来"的循环里升级会反复出现。
    const escalatedInStay = state?.escalatedInStay === true;
    const escalatedAt = typeof state?.escalatedAtChecks === "number" ? state.escalatedAtChecks : undefined;
    const escalateAllowed = escalatedAt === undefined || checks - escalatedAt >= HINT_ESCALATE_SPACING_CHECKS;
    const staleBand = !compressed && checks >= HINT_ESCALATE_AFTER_CHECKS;
    const countEscalates = demands + 1 >= HINT_ESCALATE_AT;
    const escalateDue = !compressed && !escalatedInStay && stepGapOk && (staleBand || countEscalates);
    const escalateNow = escalateDue && escalateAllowed;
    // 该升级而冷却还没过：这一步**整个静默**，等真正的升级那条发。宁可晚一步，
    // 也不要先发一条弱措辞、再补一条强措辞——那正是"同一个意思发两遍"。
    const escalateBlocked = escalateDue && !escalateAllowed;
    // "涨够了"这条也要看间隔：上一步刚提醒过就不必再提醒一次。
    const grewEnough =
      state !== undefined && stepGapOk && pressure.percent - state.percent >= HINT_STEP_PERCENT;
    const shouldHint =
      state === undefined || (compressed && stepGapOk) || escalateNow || (!escalateBlocked && grewEnough);
    // 下一步的"未理会要求数"：压缩反馈是好消息，不增加；其他通知都算一次新要求。
    const nextDemands = compressed ? demands : demands + 1;
    // 入带最低点：只往下走，用于判断"是否已从压缩后的低点涨回来"。
    const lowPercent = Math.min(
      pressure.percent,
      typeof state?.lowPercent === "number" ? state.lowPercent : pressure.percent,
    );
    // 下一次事件的基准水位：本条报道了压缩就压低到当前占用；否则等占用**真的涨回原水平**
    // 才抬高。门槛必须严格（不留 40% 的空档）：留空档时"61→52"这种半程回落正好卡在边界上，
    // 于是每一来回都算一次新事件（验证者第三、四轮各抓到一次）。
    const nextCompressHigh = compressed
      ? pressure.percent
      : lastCompressHigh === undefined || pressure.percent >= lastCompressHigh
        ? Math.max(pressure.percent, bandHigh)
        : lastCompressHigh;
    if (!shouldHint) {
      // 静默，但必须累加停留计数——否则"待久了"永远数不出来。
      // 注意：**不更新 `percent`**（它是"上次提醒时"的口径，涨幅要相对它算），
      // 并原样保留待报道的压缩事件（`pendingCompress`）——它还没被消费。
      if (typeof sessionId === "string") {
        hintState.set(sessionId, {
          ...state,
          checks,
          lowPercent,
          lastCompressHigh: nextCompressHigh,
          lastStepHadHint: false,
          prevPercent: pressure.percent,
        });
      }
      return decision;
    }
    if (typeof sessionId === "string") {
      hintState.set(sessionId, {
        percent: pressure.percent,
        lowPercent,
        count: count + 1,
        // "被忽略的要求"：只有"要求你去压"的通知才算；压缩反馈是好消息，不该涨它。
        demands: nextDemands,
        checks,
        // 本步发了通知——下一步的"相邻"判据靠这个。
        lastStepHadHint: true,
        // 待报道标记已被这一条提示消费掉（一次性）。
        pendingCompress: undefined,
        lastCompressHigh: nextCompressHigh,
        // 本步的读数，留给下一步算"步差"。
        prevPercent: pressure.percent,
        // 升级名额：本条用了就整期不再升级（等跌破阈值/压缩后重新开一期）。
        escalatedInStay: escalatedInStay || escalateNow,
        // 这次升级发生在"第几次检查"——留给下一次升级做冷却。
        escalatedAtChecks: escalateNow ? checks : escalatedAt,
      });
    }
    const text = hintText(ctx, agent.session, state, {
      compressed,
      fell: compressFell,
      // 步差要相对**上一次检查的读数**（state.prevPercent）算，不能拿 percent（那是上次通知时的口径）。
      stepFell: dropNow ? (typeof state?.prevPercent === "number" ? state.prevPercent - pressure.percent : fellNow) : undefined,
      escalated: escalateNow,
      staleBand: escalateNow && staleBand === true,
      checks,
      ignored: nextDemands,
    });
    if (text.length === 0) return decision;
    decision.messages.push(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "kaz-context-policy", form: "notice", summary: "compression-hint" },
      }),
    );
    return decision;
  });
}
