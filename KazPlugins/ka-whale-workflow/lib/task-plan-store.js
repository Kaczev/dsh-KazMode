// ka-whale-workflow —— v0.9 Task plan 独立存储（纯 ESM）
// ===========================================================================
// 存储：
//   legacy 单文件：ka-whale-workflow-task-plan.json（探针/无项目根兜底）。
//   k10 项目 run 模式：<projectRoot>/.dsh/storages/ka-whale-workflow/task-plans/
//     <sessionId>-<runId>.json + current.json（见下方 Run-scoped 区块）。
//   k10 work-log：同目录 <sessionId>-<runId>.work-log.json（terminal full report 记录）。
// 生命周期：
//   write-plan  whale_report(finalPlanPayload) → 完整计划创建/定稿 finalized；
//   decide-tools 不得写入 draft；memory/plugin-maintenance 只读/经 write-plan 改约。
//   persona=main 表示主线执行；ka_sub_whale 只接受 finalized planItemId 且只放行
//   三个 v0.9 子代理角色，persona=main 由主线执行并拒绝委派。
// Schema v2：
//   plan item 增加可选结构化字段 summary（string）、dependsOn/targets/verification
//   （string[]）。finalPlanPayload 必须先整体通过校验才落盘；任何 item 无效时
//   该 payload 完全不写入（原子）。
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Task plan 存储 schema 版本。
 * v2：新增可选结构化字段 summary/dependsOn/targets/verification，并把
 * finalPlanPayload 收严为全量校验 + 原子落盘（无效 payload 完全不写入）。
 * v1 文件仍可加载：旧 item 仅缺 v2 可选字段，必填字段形状不变。
 */
export const TASK_PLAN_STORE_VERSION = 2;

/** 允许的 plan item 状态。 */
export const PLAN_ITEM_STATUSES = Object.freeze(["draft", "finalized"]);

/** 允许的 plan item persona：main（主线执行） + v0.9 三个子代理角色。
 *  这是固定枚举；不得扩展。 */
export const PLAN_PERSONAS = Object.freeze([
  "main",
  "worker",
  "memoryMaintainer",
  "pluginMaintainer",
]);

/** 归一化字符串列表：只接受 string[]，去空、去重、保留顺序。 */
function normalizeStringList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 归一化可选 string：非 string 视为缺省（空串）；string 去首尾空白。 */
function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

const ALLOWED_PERSONAS_TEXT = PLAN_PERSONAS.join(", ");

function personaReason(rawPersona) {
  const shown =
    typeof rawPersona === "string" && rawPersona.trim().length > 0
      ? `"${rawPersona.trim()}"`
      : String(rawPersona);
  return `persona must be exactly one of: ${ALLOWED_PERSONAS_TEXT}; received ${shown}.`;
}

/**
 * 校验 finalPlanPayload 顶层形状。
 * 返回 { ok, rejected? }；失败时的外层 code 固定为 plan-item-invalid。
 * 该函数只检查容器形状；item 级校验见 validateFinalPayloadItems。
 */
export function validateFinalPlanPayload(payload) {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return {
      ok: false,
      code: "plan-item-invalid",
      rejected: [
        {
          planItemId: null,
          code: "invalid-plan-payload",
          reason: "finalPlanPayload must be an object.",
        },
      ],
    };
  }
  if (payload.status !== "finalized") {
    return {
      ok: false,
      code: "plan-item-invalid",
      rejected: [
        {
          planItemId: null,
          code: "invalid-final-status",
          reason: 'finalPlanPayload.status must be "finalized".',
        },
      ],
    };
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return {
      ok: false,
      code: "plan-item-invalid",
      rejected: [
        {
          planItemId: null,
          code: "empty-plan-items",
          reason: "finalPlanPayload.items must be a non-empty array.",
        },
      ],
    };
  }
  return { ok: true };
}

/**
 * 逐 item 校验 finalPlanPayload.items（不检查顶层容器）。
 * 返回 { ok, code?, rejected }；每一条 rejected 均为
 * { planItemId, code, reason }。错误码：
 *   missing-plan-item-id / invalid-plan-item-id / missing-persona /
 *   invalid-persona / missing-task / invalid-plan-items（非对象 item）。
 */
export function validateFinalPayloadItems(items) {
  const rejected = [];
  if (!Array.isArray(items)) {
    return {
      ok: false,
      code: "plan-item-invalid",
      rejected: [
        {
          planItemId: null,
          code: "invalid-plan-items",
          reason: "finalPlanPayload.items must be an array.",
        },
      ],
    };
  }
  items.forEach((raw, index) => {
    if (raw === null || raw === undefined || typeof raw !== "object") {
      rejected.push({
        planItemId: null,
        code: "invalid-plan-items",
        reason: `finalPlanPayload.items[${index}] must be an object.`,
      });
      return;
    }
    const rawId = raw.planItemId;
    const itemLabel =
      typeof rawId === "string" && rawId.trim().length > 0
        ? `plan item "${rawId.trim()}" (index ${index})`
        : `plan item at index ${index}`;

    if (rawId === undefined || rawId === null) {
      rejected.push({
        planItemId: null,
        code: "missing-plan-item-id",
        reason: `${itemLabel} is missing required field planItemId.`,
      });
    } else if (typeof rawId !== "string") {
      rejected.push({
        planItemId: rawId,
        code: "invalid-plan-item-id",
        reason: `${itemLabel} has planItemId of type ${typeof rawId}; planItemId must be a non-empty string.`,
      });
    } else if (rawId.trim().length === 0) {
      rejected.push({
        planItemId: "",
        code: "invalid-plan-item-id",
        reason: `${itemLabel} has empty planItemId; planItemId must be a non-empty string.`,
      });
    }

    if (raw.persona === undefined || raw.persona === null) {
      rejected.push({
        planItemId: typeof rawId === "string" ? rawId : null,
        code: "missing-persona",
        reason: `${itemLabel} is missing required field persona; persona must be exactly one of: ${ALLOWED_PERSONAS_TEXT}.`,
      });
    } else if (
      typeof raw.persona !== "string" ||
      raw.persona.trim().length === 0 ||
      !PLAN_PERSONAS.includes(raw.persona.trim())
    ) {
      rejected.push({
        planItemId: typeof rawId === "string" ? rawId : null,
        code: "invalid-persona",
        reason: `${itemLabel} has ${personaReason(raw.persona)} Allowed personas: ${ALLOWED_PERSONAS_TEXT}.`,
      });
    }

    if (typeof raw.task !== "string" || raw.task.trim().length === 0) {
      rejected.push({
        planItemId: typeof rawId === "string" ? rawId : null,
        code: "missing-task",
        reason: `${itemLabel} is missing required field task (or task is empty after trim).`,
      });
    }
  });
  return {
    ok: rejected.length === 0,
    code: rejected.length === 0 ? "ok" : "plan-item-invalid",
    rejected,
  };
}

/** 归一化一条 plan item；必填字段非法时返回 null。 */
export function normalizePlanItem(raw) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const planItemId = typeof raw.planItemId === "string" ? raw.planItemId.trim() : "";
  const persona = typeof raw.persona === "string" ? raw.persona.trim() : "";
  const task = typeof raw.task === "string" ? raw.task.trim() : "";
  if (planItemId.length === 0 || persona.length === 0 || task.length === 0) return null;
  if (!PLAN_PERSONAS.includes(persona)) return null;
  const status =
    raw.status === "finalized" || raw.status === "draft" ? raw.status : "draft";
  return {
    planItemId,
    status,
    persona,
    task,
    summary: normalizeOptionalString(raw.summary),
    dependsOn: normalizeStringList(raw.dependsOn),
    targets: normalizeStringList(raw.targets),
    verification: normalizeStringList(raw.verification),
    assignedTools: normalizeStringList(raw.assignedTools),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    finalizedAt: typeof raw.finalizedAt === "string" ? raw.finalizedAt : "",
  };
}

/**
 * 创建 task plan 存储。
 * 文件缺失/损坏时从空状态开始；每次写操作立即落盘。
 */
export function createTaskPlanStore(file) {
  const plans = {};
  try {
    if (file !== undefined && file !== null && existsSync(file)) {
      let raw = readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const container =
        parsed !== null && typeof parsed === "object" ? parsed.plans : undefined;
      if (container !== null && typeof container === "object") {
        for (const [id, rawItem] of Object.entries(container)) {
          const item = normalizePlanItem(rawItem);
          if (item !== null && item.planItemId === id) plans[id] = item;
        }
      }
    }
  } catch {
    // 损坏时从空开始，不影响主流程
  }

  function persist(source = plans) {
    if (typeof file !== "string" || file.length === 0) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ version: TASK_PLAN_STORE_VERSION, plans: source }, null, 2) + String.fromCharCode(10),
        "utf8",
      );
      return true;
    } catch {
      return false;
    }
  }

  const now = () => new Date().toISOString();

  return {
    file,
    get(planItemId) {
      if (typeof planItemId !== "string" || planItemId.length === 0) return null;
      const item = plans[planItemId];
      return item === undefined ? null : JSON.parse(JSON.stringify(item));
    },
    list() {
      return Object.values(plans).map((item) => JSON.parse(JSON.stringify(item)));
    },
    /**
     * 第一次持久化：decide-tools 的草稿 plan items。
     * 返回 { ok, items }；写入失败时 ok=false。
     * 行为保持兼容：逐条跳过非法 item（草稿路径仍允许部分写入）。
     */
    persistDraftItems(items) {
      const drafts = Array.isArray(items) ? items : [];
      const accepted = [];
      for (const raw of drafts) {
        const normalized = normalizePlanItem({ ...raw, status: "draft" });
        if (normalized === null) continue;
        const existing = plans[normalized.planItemId];
        const timestamp = now();
        const item = {
          ...normalized,
          status: "draft",
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          finalizedAt: existing?.finalizedAt || "",
        };
        plans[item.planItemId] = item;
        accepted.push(item);
      }
      if (persist() !== true) return { ok: false, items: accepted };
      return { ok: true, items: accepted.map((item) => ({ ...item })) };
    },
    /**
     * 第二次定稿：write-plan 的 finalPlanPayload。
     * 顶层必须是 { status:'finalized', items: 非空数组 }；所有 item 先整体通过
     * validateFinalPayloadItems 才可能落盘。任一无效时返回
     * { ok:false, code:'plan-item-invalid', rejected:[{ planItemId, code, reason }] }
     * 且对文件与内存均不做任何修改。
     *
     * 全部有效时：先在快照上应用，persist 成功后再提交到内存 plans，
     * 因此 I/O 失败时内存状态也不变。
     * 已存在 item 更新为 finalized；不存在但 payload 合法则直接创建 finalized。
     * 返回 { ok, items } 或 { ok:false, code, rejected?/items? }。
     */
    persistFinalPayload(payload) {
      const shapeCheck = validateFinalPlanPayload(payload);
      if (shapeCheck.ok !== true) {
        return { ok: false, code: "plan-item-invalid", rejected: shapeCheck.rejected };
      }
      const itemCheck = validateFinalPayloadItems(payload.items);
      if (itemCheck.ok !== true) {
        return { ok: false, code: "plan-item-invalid", rejected: itemCheck.rejected };
      }
      const timestamp = now();
      const staged = {};
      const accepted = [];
      for (const raw of payload.items) {
        const normalized = normalizePlanItem({
          ...raw,
          status: "finalized",
          finalizedAt:
            typeof raw.finalizedAt === "string" ? raw.finalizedAt : "",
        });
        if (normalized === null) {
          // 校验已全量通过，理论上不可达；仍保留防御性拒绝以保证原子。
          return {
            ok: false,
            code: "plan-item-invalid",
            rejected: [
              {
                planItemId:
                  typeof raw?.planItemId === "string" ? raw.planItemId : null,
                code: "plan-item-schema",
                reason: "plan item did not normalize after validation; payload rejected as a whole.",
              },
            ],
          };
        }
        const existing = plans[normalized.planItemId];
        const item = {
          ...normalized,
          status: "finalized",
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          finalizedAt: existing?.finalizedAt || timestamp,
        };
        staged[item.planItemId] = item;
        accepted.push(item);
      }
      const nextPlans = { ...plans, ...staged };
      if (persist(nextPlans) !== true) {
        return { ok: false, code: "plan-persist-failed", items: accepted.map((item) => ({ ...item })) };
      }
      // 持久化成功后才提交内存快照；plans 未在失败路径被改动。
      Object.assign(plans, staged);
      return { ok: true, items: accepted.map((item) => ({ ...item })) };
    },
    remove(planItemId) {
      if (typeof planItemId !== "string" || planItemId.length === 0) return false;
      if (!Object.prototype.hasOwnProperty.call(plans, planItemId)) return false;
      delete plans[planItemId];
      persist();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Run-scoped per-project task plans（k10-project-store）
// ---------------------------------------------------------------------------
// 布局：
//   <projectRoot>/.dsh/storages/ka-whale-workflow/task-plans/<sessionId>-<runId>.json
//   <projectRoot>/.dsh/storages/ka-whale-workflow/task-plans/current.json
// Run 语义：
//   - runId 来自 stage store workflowRuns[sessionId].runId（assess 重置时递增）；
//     一个活动 run 内多次回 write-plan 修订都写同一个 run 文件。
//   - current.json 延迟写入：第一次 finalPlanPayload 成功落盘时才创建/更新；
//     修订只更新同一 run 文件并刷新 pointer。
//   - 旧全局单文件（createTaskPlanStore）保持 legacy 兼容；本项目不使用它迁移。
// ---------------------------------------------------------------------------

export const TASK_PLAN_RUN_CURRENT_VERSION = 1;

/** 把 session/run 片段转成安全的文件名字段（防路径分隔/非法字符）。 */
function safeFileComponent(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

/** `<projectRoot>/.dsh/storages/ka-whale-workflow/task-plans` 目录。 */
export function taskPlansDirectoryFor(projectRoot) {
  return join(resolve(String(projectRoot ?? ".")), ".dsh", "storages", "ka-whale-workflow", "task-plans");
}

/** 某个 session/workflow-run 的 plan 文件路径。 */
export function runPlanFileFor(projectRoot, sessionId, runId) {
  return join(
    taskPlansDirectoryFor(projectRoot),
    `${safeFileComponent(sessionId)}-${safeFileComponent(runId)}.json`,
  );
}

/** 项目 current pointer 文件路径。 */
export function currentRunPointerFileFor(projectRoot) {
  return join(taskPlansDirectoryFor(projectRoot), "current.json");
}

/** 读取 run 文件的归一化 items；文件缺失/损坏视为空数组。 */
export function readRunPlanItems(planFile) {
  if (typeof planFile !== "string" || planFile.length === 0 || !existsSync(planFile)) return [];
  try {
    const store = createTaskPlanStore(planFile);
    return store.list();
  } catch {
    return [];
  }
}

/** 读取 current.json；缺失/损坏返回 null。 */
export function readCurrentRunPointer(projectRoot) {
  const file = currentRunPointerFileFor(projectRoot);
  try {
    if (!existsSync(file)) return null;
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const runId =
      typeof parsed.runId === "string" || Number.isSafeInteger(parsed.runId)
        ? parsed.runId
        : "";
    const planFile = typeof parsed.planFile === "string" ? parsed.planFile : "";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    if (sessionId.length === 0 || runId === "" || planFile.length === 0) return null;
    return {
      version: parsed.version === 1 ? 1 : TASK_PLAN_RUN_CURRENT_VERSION,
      sessionId,
      runId,
      updatedAt,
      planFile,
    };
  } catch {
    return null;
  }
}

/** 写 current.json；返回 true/false。 */
export function writeCurrentRunPointer(projectRoot, { sessionId, runId, updatedAt, planFile }) {
  try {
    const file = currentRunPointerFileFor(projectRoot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: TASK_PLAN_RUN_CURRENT_VERSION,
          sessionId: String(sessionId),
          runId,
          updatedAt: typeof updatedAt === "string" ? updatedAt : new Date().toISOString(),
          planFile: String(planFile),
        },
        null,
        2,
      ) + String.fromCharCode(10),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 finalPlanPayload 原子地写入某个 run 文件并刷新 current pointer。
 * 复用一个 createTaskPlanStore(runFile)，因此继承 k10-plan-schema 的全量
 * 校验/拒绝语义：任何 item 无效时 run 文件与 current.json 都不动。
 * 返回 { ok:true, items, planFile, currentPointerFile }
 *   或 { ok:false, code, rejected?/items?, planFile }。
 */
export function persistFinalPlanRun({ projectRoot, sessionId, runId, payload }) {
  const planFile = runPlanFileFor(projectRoot, sessionId, runId);
  const store = createTaskPlanStore(planFile);
  const result = store.persistFinalPayload(payload);
  if (result.ok !== true) {
    return { ...result, planFile };
  }
  const updatedAt = new Date().toISOString();
  if (
    writeCurrentRunPointer(projectRoot, {
      sessionId,
      runId,
      updatedAt,
      planFile,
    }) !== true
  ) {
    return {
      ok: false,
      code: "plan-persist-failed",
      items: result.items,
      planFile,
      reason: "task plan run file was written but current.json pointer write failed.",
    };
  }
  return {
    ok: true,
    items: result.items,
    planFile,
    currentPointerFile: currentRunPointerFileFor(projectRoot),
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Run-scoped work-log（k10-work-log）
// ---------------------------------------------------------------------------
// 每个 active run 一个 <sessionId>-<runId>.work-log.json，与 task plan 同目录；
// 不写入 plan item JSON。entries 只追加：seq 单调递增。best-effort 语义由
// 调用方保证：legacy/no-run 场景不应抛错打断主流程。
// ---------------------------------------------------------------------------

export const TASK_PLAN_WORK_LOG_VERSION = 1;

/** active run 的 work-log 文件路径。 */
export function workLogFileFor(projectRoot, sessionId, runId) {
  return join(
    taskPlansDirectoryFor(projectRoot),
    `${safeFileComponent(sessionId)}-${safeFileComponent(runId)}.work-log.json`,
  );
}

function normalizeWorkLogEntry(raw, index) {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const seq = Number.isSafeInteger(raw.seq) && raw.seq > 0 ? raw.seq : index + 1;
  return {
    seq,
    at: typeof raw.at === "string" ? raw.at : "",
    role: typeof raw.role === "string" ? raw.role : "",
    planItemId: typeof raw.planItemId === "string" ? raw.planItemId : "",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    report: typeof raw.report === "string" ? raw.report : "",
  };
}

/** 读取 work-log 文件；缺失/损坏视为空 entries。 */
export function readWorkLogEntries(projectRoot, sessionId, runId) {
  try {
    const file = workLogFileFor(projectRoot, sessionId, runId);
    if (!existsSync(file)) return [];
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    const rawEntries = parsed !== null && typeof parsed === "object" && Array.isArray(parsed.entries)
      ? parsed.entries
      : [];
    return rawEntries
      .map((entry, index) => normalizeWorkLogEntry(entry, index))
      .filter((entry) => entry !== null)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/**
 * 向 active run 的 work-log 追加一条 entry。
 * 原子 read-modify-write（同步单文件写）；任何 I/O/形状异常返回 ok:false，
 * 不向上抛错。返回 { ok, file?, seq? }。
 */
export function appendWorkLogEntry({ projectRoot, sessionId, runId, role, planItemId, summary, report, at }) {
  try {
    const file = workLogFileFor(projectRoot, sessionId, runId);
    const existing = readWorkLogEntries(projectRoot, sessionId, runId);
    const seq = existing.length === 0 ? 1 : Math.max(...existing.map((entry) => entry.seq)) + 1;
    const entry = {
      seq,
      at: typeof at === "string" && at.length > 0 ? at : new Date().toISOString(),
      role: typeof role === "string" ? role : "",
      planItemId: typeof planItemId === "string" ? planItemId : "",
      summary: typeof summary === "string" ? summary : "",
      report: typeof report === "string" ? report : "",
    };
    const nextEntries = [...existing, entry].map((item, index) =>
      normalizeWorkLogEntry(item, index),
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: TASK_PLAN_WORK_LOG_VERSION,
          runId,
          entries: nextEntries,
        },
        null,
        2,
      ) + String.fromCharCode(10),
      "utf8",
    );
    return { ok: true, file, seq };
  } catch {
    return { ok: false };
  }
}

/**
 * 解析 ka_sub_whale 使用的 planItemId。
 * 返回 { ok:true, item } 或 { ok:false, code, reason }。
 * - plan-item-not-found：不存在 / 未持久化；
 * - plan-item-not-finalized：存在但仍是 draft。
 */
export function resolvePlanItemForDelegation(store, planItemId) {
  const id = typeof planItemId === "string" ? planItemId.trim() : "";
  if (id.length === 0) {
    return {
      ok: false,
      code: "plan-item-not-found",
      reason: "ka_sub_whale requires a planItemId; missing or empty planItemId was rejected.",
    };
  }
  const item = store !== null && typeof store.get === "function" ? store.get(id) : null;
  if (item === null) {
    return {
      ok: false,
      code: "plan-item-not-found",
      reason: `ka_sub_whale rejected planItemId "${id}": no persisted task plan item exists with that id.`,
    };
  }
  if (item.status !== "finalized") {
    return {
      ok: false,
      code: "plan-item-not-finalized",
      reason: `ka_sub_whale rejected planItemId "${id}": task plan item exists but status is "${item.status}", not "finalized". Only finalized plan items can be delegated.`,
    };
  }
  return { ok: true, item: JSON.parse(JSON.stringify(item)) };
}
