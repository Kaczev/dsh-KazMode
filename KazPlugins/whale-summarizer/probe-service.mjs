#!/usr/bin/env node
// probe-service.mjs —— offline service/stream-stub probe for whale-summarizer.
// No real LLM or network. Injects stub ctx.llm.stream / resolveCallConfig / kazMode.

import pluginDefault, {
  isWhaleSummarizerScopeAllowed,
  resolveWhaleSummarizerRoute,
} from "./lib/index.js";
import { ERROR_CODES } from "./lib/core.mjs";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function textStreamFactory(text) {
  return async function* textStream(_options) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}

function failingStreamFactory(error) {
  return async function* failingStream() {
    throw error;
  };
}

function makeAgent(options = {}) {
  const id = options.id ?? "kaz-main";
  return {
    id,
    options: options.options ?? {},
    session: {
      id: options.sessionId ?? `session-${id}`,
      requestHeader: () =>
        options.header === undefined ? undefined : { config: options.header },
    },
  };
}

function makeContext(overrides = {}) {
  const calls = { stream: [], resolveCallConfig: [] };
  const provided = {};
  const effects = [];
  const toolsCalls = [];
  const kazEnabled = overrides.kazEnabled ?? (() => true);
  const workflow = overrides.workflow ?? null;
  const rawResolveCallConfig =
    overrides.resolveCallConfig ??
    (async (config) => {
      return config;
    });
  const rawStream =
    overrides.stream ??
    (async function* stream() {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "default summary" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "default summary" } };
      yield { type: "finish", reason: { kind: "stop" } };
    });
  const llm = {
    async resolveCallConfig(config) {
      calls.resolveCallConfig.push(config);
      return rawResolveCallConfig(config);
    },
    async *stream(options) {
      calls.stream.push(options);
      yield* rawStream(options);
    },
  };
  const agentDefaultModel = overrides.agentDefaultModel ?? {
    currentSelection: () => ({
      provider: "default-provider",
      model: "default-model",
    }),
  };
  const ctx = {
    llm,
    agentDefaultModel,
    logger: { info() {}, debug() {}, warn() {} },
    get(name) {
      if (name === "llm") return llm;
      if (name === "kazMode") return { kazEnabled };
      if (name === "kaWhaleWorkflow") return workflow;
      if (name === "agentDefaultModel") return agentDefaultModel;
      return undefined;
    },
    provide(name, service) {
      provided[name] = service;
      return () => {
        delete provided[name];
      };
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") effects.push(cleanup);
    },
    tools: {
      register() {
        toolsCalls.push([...arguments]);
        throw new Error("whale-summarizer must not register tools");
      },
    },
  };
  return { ctx, calls, provided, effects, toolsCalls };
}

function installService(env) {
  pluginDefault.apply(env.ctx, {});
  return env.provided?.whaleSummarizer;
}

function validInput() {
  return {
    evidence: [
      { kind: "leaf", id: "leaf-1", text: "original raw text A", path: "r/leaf-1" },
      { kind: "block", id: "block-2", text: "prior block summary B", path: "r/block-2" },
    ],
    refs: [
      { kind: "leaf", id: "leaf-1", path: "r/leaf-1", seq: 11 },
      { kind: "block", id: "block-2", path: "r/block-2" },
    ],
    purpose: "close-round",
  };
}

const checks = [];

checks.push(async () => {
  const env = makeContext({ stream: textStreamFactory("Good summary.") });
  pluginDefault.apply(env.ctx, {});
  const service = env.provided.whaleSummarizer;
  if (!service) throw new Error("service not provided");
  if (typeof service.summarize !== "function") throw new Error("summarize missing");
  if (env.toolsCalls.length !== 0) throw new Error("tools.register called");
  const agent = makeAgent({
    header: { provider: "header-provider", model: "header-model" },
  });
  const result = await service.summarize(validInput(), { agent });
  if (result.summary !== "Good summary.") throw new Error(`summary=${result.summary}`);
  if (JSON.stringify(result.sourceIds) !== JSON.stringify(["leaf-1", "block-2"])) {
    throw new Error(`sourceIds=${JSON.stringify(result.sourceIds)}`);
  }
  if (env.calls.stream.length !== 1) throw new Error(`stream calls=${env.calls.stream.length}`);
  const options = env.calls.stream[0];
  if (options.provider !== "header-provider" || options.model !== "header-model") {
    throw new Error(`route=${options.provider}/${options.model}`);
  }
  if (options.reasoningEffort !== "off") throw new Error(`reasoningEffort=${options.reasoningEffort}`);
  if (!Array.isArray(options.messages) || options.messages.length !== 1 || options.messages[0].role !== "user") {
    throw new Error("not one standalone user message");
  }
  if (options.system !== undefined || options.tools !== undefined || options.purpose !== undefined) {
    throw new Error("system/tools/purpose present");
  }
  if (env.calls.resolveCallConfig.length !== 1) throw new Error("resolveCallConfig not prechecked");
  if (env.calls.resolveCallConfig[0].reasoningEffort !== "off") throw new Error("precheck not off");
});

checks.push(async () => {
  const env = makeContext();
  const service = installService(env);
  const agent = makeAgent({
    header: { provider: "header-provider", model: "header-model" },
    options: { provider: "option-provider", model: "option-model" },
  });
  await service.summarize(validInput(), { agent });
  if (env.calls.stream[0].provider !== "header-provider") throw new Error("header priority failed");
});

checks.push(async () => {
  const env = makeContext();
  const service = installService(env);
  const agent = makeAgent({
    options: { provider: "option-provider", model: "option-model" },
  });
  await service.summarize(validInput(), { agent });
  if (env.calls.stream[0].provider !== "option-provider") throw new Error("agent.options priority failed");
});

checks.push(async () => {
  const env = makeContext({
    agentDefaultModel: {
      currentSelection: () => ({ provider: "default-provider", model: "default-model" }),
    },
  });
  const service = installService(env);
  const agent = makeAgent({});
  await service.summarize(validInput(), { agent });
  if (env.calls.stream[0].provider !== "default-provider") throw new Error("agentDefaultModel priority failed");
});

checks.push(async () => {
  const env = makeContext({
    agentDefaultModel: { currentSelection: () => undefined },
  });
  const service = installService(env);
  const agent = makeAgent({});
  let rejected = null;
  try {
    await service.summarize(validInput(), { agent });
  } catch (error) {
    rejected = error;
  }
  if (!rejected || rejected.code !== ERROR_CODES.NO_ROUTE) throw new Error(`expected NO_ROUTE, got ${rejected?.code ?? rejected}`);
  if (env.calls.stream.length !== 0) throw new Error("stream called without route");
});

checks.push(async () => {
  const env = makeContext({
    resolveCallConfig: async () => {
      throw Object.assign(new Error("unsupported effort"), { code: "UNSUPPORTED_REASONING_EFFORT" });
    },
  });
  const service = installService(env);
  const agent = makeAgent({ header: { provider: "p", model: "m" } });
  let rejected = null;
  try {
    await service.summarize(validInput(), { agent });
  } catch (error) {
    rejected = error;
  }
  if (!rejected || rejected.code !== ERROR_CODES.UNSUPPORTED_REASONING_OFF) {
    throw new Error(`expected UNSUPPORTED_REASONING_OFF, got ${rejected?.code ?? rejected}`);
  }
  if (env.calls.stream.length !== 0) throw new Error("stream called when reasoning-off not guaranteed");
});

checks.push(async () => {
  const env = makeContext({ kazEnabled: () => false, workflow: null });
  const service = installService(env);
  const agent = makeAgent({ header: { provider: "p", model: "m" } });
  let rejected = null;
  try {
    await service.summarize(validInput(), { agent });
  } catch (error) {
    rejected = error;
  }
  if (rejected && rejected.code === ERROR_CODES.SCOPE_DENIED) {
    throw new Error("scope still denies a real agent after relaxation");
  }
});

checks.push(async () => {
  let attempt = 0;
  const env = makeContext({
    stream: async function* stream(options) {
      attempt += 1;
      if (attempt < 3) throw new Error(`attempt ${attempt} network failure`);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "retry ok" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "retry ok" } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  });
  const service = installService(env);
  const agent = makeAgent({ header: { provider: "p", model: "m" } });
  const result = await service.summarize(validInput(), { agent });
  if (result.summary !== "retry ok") throw new Error("retry did not succeed");
  if (attempt !== 3) throw new Error(`attempt count=${attempt}, expected 3`);
});

checks.push(async () => {
  let attempt = 0;
  const env = makeContext({
    stream: async function* stream() {
      attempt += 1;
      throw new Error("persistent failure");
    },
  });
  const service = installService(env);
  const agent = makeAgent({ header: { provider: "p", model: "m" } });
  let rejected = null;
  try {
    await service.summarize(validInput(), { agent });
  } catch (error) {
    rejected = error;
  }
  if (!rejected || rejected.code !== ERROR_CODES.SUMMARY_FAILED) {
    throw new Error(`expected SUMMARY_FAILED, got ${rejected?.code ?? rejected}`);
  }
  if (attempt !== 3) throw new Error(`attempt count=${attempt}, expected 3`);
});

checks.push(async () => {
  const realAgent = makeAgent({});
  if (isWhaleSummarizerScopeAllowed({}, realAgent) !== true) throw new Error("real agent denied");
  if (isWhaleSummarizerScopeAllowed({}, null) !== false) throw new Error("null not fail-closed");
  if (isWhaleSummarizerScopeAllowed({}, undefined) !== false) throw new Error("undefined not fail-closed");
  if (typeof resolveWhaleSummarizerRoute !== "function") throw new Error("route helper missing");
});

for (const fn of checks) {
  await check(fn.name || "service check", fn);
}

if (failed > 0) {
  console.error(`probe-service.mjs FAILED (${failed})`);
  process.exitCode = 1;
} else {
  console.log(`probe-service.mjs ALL PASS (${passed})`);
}
