// ka-whale-workflow —— v0.9 Task plan 独立存储（纯 ESM）
// ===========================================================================
// 存储文件：ka-whale-workflow-task-plan.json（与 stage store 同目录）。
// 生命周期：
//   decide-tools whale_report(draftPlanItems) → 草稿 draft；
//   write-plan  whale_report(finalPlanPayload) → 完整计划定稿 finalized；
//   persona=main 表示主线执行；ka_sub_whale 只接受 finalized planItemId 且只放行
//   四个 v0.9 子代理角色，persona=main 由主线执行并拒绝委派。
// ===========================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Task plan 存储 schema 版本。 */
export const TASK_PLAN_STORE_VERSION = 1;

/** 允许的 plan item 状态。 */
export const PLAN_ITEM_STATUSES = Object.freeze(["draft", "finalized"]);

/** 允许的 plan item persona：main（主线执行） + v0.9 四个子代理角色。
 *  pluginCreator is store-only/unused: the role definition remains, but no main
 *  stage delegates it. */
export const PLAN_PERSONAS = Object.freeze([
  "main",
  "worker",
  "memoryMaintainer",
  "pluginMaintainer",
  "pluginCreator",
]);

/** 归一化工具名列表：去空、去重、保留顺序。 */
function normalizeToolList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string") continue;
    const tool = item.trim();
    if (tool.length === 0 || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

/** 归一化一条 plan item；形状非法返回 null。 */
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
    assignedTools: normalizeToolList(raw.assignedTools),
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

  function persist() {
    if (typeof file !== "string" || file.length === 0) return true;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ version: TASK_PLAN_STORE_VERSION, plans }, null, 2) + String.fromCharCode(10),
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
     * 已存在 item 更新为 finalized；不存在但 payload 合法则直接创建 finalized。
     * 返回 { ok, items, missingPersona? }。
     */
    persistFinalPayload(payload) {
      const value =
        payload !== null && typeof payload === "object" ? payload : {};
      const items = Array.isArray(value.items) ? value.items : [];
      const accepted = [];
      for (const raw of items) {
        const normalized = normalizePlanItem({
          ...raw,
          status: "finalized",
          finalizedAt:
            typeof raw.finalizedAt === "string" ? raw.finalizedAt : "",
        });
        if (normalized === null) continue;
        const existing = plans[normalized.planItemId];
        const timestamp = now();
        const item = {
          ...normalized,
          status: "finalized",
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          finalizedAt: existing?.finalizedAt || timestamp,
        };
        plans[item.planItemId] = item;
        accepted.push(item);
      }
      if (persist() !== true) return { ok: false, items: accepted };
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
