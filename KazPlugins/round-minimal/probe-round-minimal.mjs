// 临时探针：在 mock 的 Cordis ctx 上运行 round-minimal 插件，验证核心逻辑。
// 覆盖：① 首轮（turn 1）提醒段文本；② 次轮（turn 2）提醒为空；
// ③ 子代理默认排除 / includeSubagents=true 时纳入；④ 组装层工具过滤；
// ⑤ 执行层拒绝；⑥ enabled=false 完全停用。
// 运行：node probe-round-minimal.mjs
import plugin from "file:///C:/Users/Kaczev/.dsh/profiles/web/plugins/round-minimal/lib/index.js";

// —— mock 代理 ——
function makeAgent(turn, opts = {}) {
  const events = [];
  for (let t = 1; t <= turn; t += 1) events.push({ type: "turn/start", data: { turn: t } });
  if (opts.descriptor === true) events.push({ type: "subagent/descriptor", data: { mode: "one-shot" } });
  return {
    id: opts.id ?? `agent-turn${turn}`,
    options: { subagentDepth: opts.depth ?? 0 },
    session: { events },
  };
}

// —— mock ctx ——
const listeners = new Map();
const provided = {};
const emitted = [];
let storedSection = null;
const ctx = {
  inject() {},
  effect(fn) {
    fn();
    return () => {};
  },
  provide(name, value) {
    provided[name] = value;
    return () => {
      delete provided[name];
    };
  },
  emit(event, ...args) {
    emitted.push({ event, args });
  },
  logger: {
    info: () => {},
    warn: (...args) => console.log("[mock:warn]", ...args),
    debug: () => {},
  },
  systemPrompt: {
    section(section) {
      storedSection = section;
      return () => {};
    },
  },
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {};
  },
};

const sectionText = (agent) => storedSection.text({ agent, scope: agent });
const runAssemble = async (agent, tools) => {
  const listener = listeners.get("system-prompt/assemble")[0];
  const sections = tools.map((name) => ({ name: `tool:${name}`, text: `guidance for ${name}` }));
  const assembly = { tools: tools.map((name) => ({ name })), sections: [...sections, { name: "persona", text: "x" }], contexts: [], variables: {} };
  await listener(assembly, { agent, scope: agent }, () => Promise.resolve(assembly));
  return assembly;
};
const runGate = async (agent, name) => {
  const gate = listeners.get("tools/pre-execute")[0];
  return gate({ name, agent }, () => Promise.resolve({ kind: "allow" }));
};

const TOOLS = ["pwsh", "str_replace_editor", "read", "write", "edit", "glob", "grep", "subagent", "workflow", "web_search"];

// 1) 默认配置（includeSubagents=false）
plugin.apply(ctx, { enabled: true });
let failed = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
};

// ① 轮次提示：首轮 / 第二轮 / 第三轮起
const turn1 = makeAgent(1);
const turn2 = makeAgent(2);
const turn3 = makeAgent(3);
const text1 = sectionText(turn1);
check("首轮（turn1）提示段应包含 We need 首轮指令", text1.includes("We need to treat this as the first round") && text1.includes("do not execute the task yet"));
check("首轮提示段不应再包含旧版'请在第一句话中'用户提醒", !text1.includes("请在第一句话中"));
check("首轮提示段使用 [标题] > < 信封格式", text1.startsWith("[round-minimal First Round Mode]") && text1.includes("\n>\n") && text1.trimEnd().endsWith("<"));
check("首轮提示附 run_code/pwsh 使用要点", text1.includes("[run_code / pwsh quick rules]") && text1.includes(".text") && text1.includes("Get-Content") && text1.includes("BOM"));
const text2 = sectionText(turn2);
check("第二轮（turn2）提示段应包含 second-round 提醒", text2.includes("[round-minimal Second Round Reminder]") && text2.includes("We can start executing the task."));
check("第三轮（turn3）提示段应为空", sectionText(turn3) === "");

// ③ 子代理默认排除
const sub1 = makeAgent(1, { depth: 1 });
check("子代理（subagentDepth=1, turn1）默认不注入提示", sectionText(sub1) === "");
const sub2 = makeAgent(2, { depth: 1 });
check("子代理（subagentDepth=1, turn2）默认不注入第二轮提示", sectionText(sub2) === "");
const subDescriptor1 = makeAgent(1, { descriptor: true });
check("子代理（subagent/descriptor, turn1）默认不注入提示", sectionText(subDescriptor1) === "");

// ⑦ 对外信号：roundMinimal 服务 + round-minimal/state 事件
const rmSvc = provided.roundMinimal;
check("roundMinimal 服务已发布（enabled/isMinimal/firstRoundTools/turnOf）",
  rmSvc !== undefined && typeof rmSvc.enabled === "function" && typeof rmSvc.isMinimal === "function" &&
  typeof rmSvc.firstRoundTools === "function" && typeof rmSvc.turnOf === "function");
check("roundMinimal.enabled() = true", rmSvc !== undefined && rmSvc.enabled() === true);
check("roundMinimal.isMinimal(turn1) = true", rmSvc !== undefined && rmSvc.isMinimal(turn1) === true);
check("roundMinimal.isMinimal(turn2) = false", rmSvc !== undefined && rmSvc.isMinimal(turn2) === false);
check("roundMinimal.isMinimal(子代理) = false（默认排除）", rmSvc !== undefined && rmSvc.isMinimal(sub1) === false);
check("roundMinimal.firstRoundTools() = [pwsh, str_replace_editor]", rmSvc !== undefined && JSON.stringify(rmSvc.firstRoundTools()) === JSON.stringify(["pwsh", "str_replace_editor"]));
check("roundMinimal.turnOf(turn2) = 2", rmSvc !== undefined && rmSvc.turnOf(turn2) === 2);

// ② 组装层过滤：首轮只留白名单
const asm1 = await runAssemble(turn1, TOOLS);
check("首轮组装工具只剩 pwsh + str_replace_editor", asm1.tools.length === 2 && asm1.tools.every((t) => t.name === "pwsh" || t.name === "str_replace_editor"));
check("首轮 tool:* 指导段同步过滤", asm1.sections.every((s) => !s.name.startsWith("tool:") || s.name === "tool:pwsh" || s.name === "tool:str_replace_editor"));
check("首轮非 tool:* 段（persona）保留", asm1.sections.some((s) => s.name === "persona"));

const asm2 = await runAssemble(turn2, TOOLS);
check("次轮组装工具完整恢复", asm2.tools.length === TOOLS.length && asm2.tools.map((t) => t.name).join(",") === TOOLS.join(","));
check("次轮 tool:* 指导段完整保留", asm2.sections.filter((s) => s.name.startsWith("tool:")).length === TOOLS.length);

// ⑦ 信号事件：组装时推送 round-minimal/state（首轮 true → 次轮 false）
const sigOn = emitted.filter((e) => e.event === "round-minimal/state" && e.args[0]?.minimal === true && e.args[0]?.turn === 1);
const sigOff = emitted.filter((e) => e.event === "round-minimal/state" && e.args[0]?.minimal === false && e.args[0]?.turn === 2);
check("组装首轮发出 round-minimal/state（minimal=true, turn=1）", sigOn.length >= 1);
check("组装次轮发出 round-minimal/state（minimal=false, turn=2）", sigOff.length >= 1);
check("信号载荷含 firstRoundTools 列表", sigOn[0] !== undefined && Array.isArray(sigOn[0].args[0]?.firstRoundTools));

// ⑤ 执行层闸门
const denyRead = await runGate(turn1, "read");
check("首轮调用 read 被拒绝", denyRead.kind === "deny" && typeof denyRead.reason === "string" && denyRead.reason.includes("首轮"));
const allowPwsh = await runGate(turn1, "pwsh");
check("首轮调用 pwsh 放行", allowPwsh.kind === "allow");
const allowReadTurn2 = await runGate(turn2, "read");
check("次轮调用 read 放行", allowReadTurn2.kind === "allow");
const allowSubRead = await runGate(sub1, "read");
check("子代理调用 read 放行（默认排除）", allowSubRead.kind === "allow");

// ③ includeSubagents=true 时纳入子代理
listeners.clear();
storedSection = null;
plugin.apply(ctx, { enabled: true, includeSubagents: true });
check("includeSubagents=true：子代理首轮注入提示", sectionText(sub1) !== "");
check("includeSubagents=true：子代理第二轮注入提示", sectionText(sub2) !== "");
const asmSub = await runAssemble(sub1, TOOLS);
check("includeSubagents=true：子代理首轮工具被过滤", asmSub.tools.length === 2);
const denySubRead = await runGate(sub1, "read");
check("includeSubagents=true：子代理首轮调用 read 被拒绝", denySubRead.kind === "deny");

// ⑥ enabled=false 完全停用
listeners.clear();
storedSection = null;
plugin.apply(ctx, { enabled: false });
check("enabled=false：提示为空", sectionText(turn1) === "");
check("enabled=false：第二轮提示为空", sectionText(turn2) === "");
const asmOff = await runAssemble(turn1, TOOLS);
check("enabled=false：工具不被过滤", asmOff.tools.length === TOOLS.length);
const gateOff = await runGate(turn1, "read");
check("enabled=false：调用不被拒绝", gateOff.kind === "allow");

// ⑧ showPolicy=false：轮次提示段整体不输出（Kaz 模式联动会临时关掉它）
listeners.clear();
storedSection = null;
plugin.apply(ctx, { enabled: true, showPolicy: false });
check("showPolicy=false：首轮提示为空", sectionText(turn1) === "");
check("showPolicy=false：第二轮提示为空", sectionText(turn2) === "");
check("showPolicy=false：首轮工具过滤仍生效", (await runAssemble(turn1, TOOLS)).tools.length === 2);

// ⑨ showPolicy 恢复 true：提示正常输出
listeners.clear();
storedSection = null;
plugin.apply(ctx, { enabled: true, showPolicy: true });
check("showPolicy=true：首轮提示恢复", sectionText(turn1).includes("We need to treat this as the first round"));
check("showPolicy=true：第二轮提示恢复", sectionText(turn2).includes("We can start executing the task."));

// ⑩ task-master-whiteboard 存在且启用时：首轮自动放行六个白板工具
ctx.get = (name) => {
  if (name === "settings") {
    return { get: (ns) => (ns === "task-master-whiteboard" ? { enabled: true } : undefined) };
  }
  return undefined;
};
listeners.clear();
storedSection = null;
plugin.apply(ctx, { enabled: true });
check("白板插件存在时 firstRoundTools 含六个白板工具", (() => {
  const tools = provided.roundMinimal.firstRoundTools();
  return (
    tools.includes("new_whiteboard") &&
    tools.includes("list_whiteboards") &&
    tools.includes("read_whiteboard") &&
    tools.includes("append_whiteboard") &&
    tools.includes("update_whiteboard") &&
    tools.includes("clear_whiteboard") &&
    tools.length === 8
  );
})());
const wbTools = [...TOOLS, "new_whiteboard", "list_whiteboards", "read_whiteboard", "append_whiteboard", "update_whiteboard", "clear_whiteboard"];
const asmWb = await runAssemble(turn1, wbTools);
check("白板插件存在时首轮组装放行白板工具", asmWb.tools.some((t) => t.name === "new_whiteboard") && asmWb.tools.length === 8);
const gateWb = await runGate(turn1, "new_whiteboard");
check("白板插件存在时首轮调用白板工具放行", gateWb.kind === "allow");
const gateWbRead = await runGate(turn1, "read");
check("白板插件存在时首轮 read 仍被拒绝（白名单外）", gateWbRead.kind === "deny");
delete ctx.get;

if (failed > 0) {
  console.error(`\nPROBE FAILED (${failed} 项断言失败)`);
  process.exit(1);
}
console.log("\nPROBE OK");
process.exit(0);
