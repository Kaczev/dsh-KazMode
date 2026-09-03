// kaz-shared —— Kaz 6.0 Step 2 维护子代理结构化短 report / 物理删除闸门（纯 ESM）
// ===========================================================================
// 目标：
//   1) 维护/外包子代理返回“结论 / 证据 / 失败与阻塞 / 下一步建议”的结构化短
//      report；主模型只消费这份短 report，不重读被维护全文。
//   2) 物理删除（memory_forget / 工具/技能生命周期移除）仍由维护子代理执行，
//      但必须带主模型批准 + 删除前备份 + 审计痕迹。
//
// 本文件不依赖 cordis / dsh 服务，供维护子代理提示词/结果解析、编排层与探针共用。
// ===========================================================================

/** 结构化 report 固定字段（顺序即规范）。 */
export const MAINTENANCE_REPORT_FIELDS = Object.freeze([
  "conclusion",
  "evidence",
  "failures",
  "next",
]);

/** 短 report 单条证据/失败的推荐上限（超长内容由维护子代理留原文、只回摘要）。 */
export const MAINTENANCE_REPORT_ITEM_MAX = 8;

/** 短 report 总字符上限（主模型读完后不应再需要全文回读）。 */
export const MAINTENANCE_REPORT_MAX_CHARS = 2000;

function cleanString(value, max = Infinity) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cleanStringList(value, maxItems = MAINTENANCE_REPORT_ITEM_MAX) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text.length === 0) continue;
    out.push(text.length > 240 ? `${text.slice(0, 240)}…` : text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 归一化结构化 report：返回 { ok, report } 或 { ok:false, error }。
 * conclusion 必填；evidence/failures/next 可缺省。
 */
export function normalizeMaintenanceReport(value) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "maintenance-report: expected an object" };
  }
  const conclusion = cleanString(value.conclusion);
  if (conclusion.length === 0) {
    return { ok: false, error: "maintenance-report: `conclusion` is required" };
  }
  const evidence = cleanStringList(value.evidence);
  const failures = cleanStringList(value.failures);
  const next = cleanString(value.next, 400);
  return { ok: true, report: { conclusion, evidence, failures, next } };
}

/** 把结构化 report 编码成一行式文本（不携带被维护全文）。 */
export function maintenanceReportToText(report) {
  const normalized = normalizeMaintenanceReport(report);
  if (!normalized.ok) throw new Error(normalized.error);
  const r = normalized.report;
  return [
    `Conclusion: ${r.conclusion}`,
    `Evidence: [${r.evidence.join(" | ")}]`,
    `Failures: [${r.failures.join(" | ")}]`,
    `Next: ${r.next}`,
  ].join("\n");
}

/** 从子代理自由文本中提取结构化 report（接受 JSON 或 Markdown 标题两种形态）。 */
export function parseMaintenanceReport(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "maintenance-report: empty child text" };
  }
  // 形态 1：整段或含 JSON 块。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return normalizeMaintenanceReport(parsed);
    } catch {
      // 继续尝试 Markdown 形态。
    }
  }
  // 形态 2：Markdown / 简单标题 / “Field: value” 行。
  const lines = text.split(/\r?\n/);
  const found = { conclusion: "", evidence: [], failures: [], next: "" };
  let section = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const head = trimmed.match(/^#{1,6}\s*(.*)$/);
    if (head) {
      const title = head[1].trim().toLowerCase();
      if (title === "conclusion" || title.includes("conclusion")) section = "conclusion";
      else if (title === "evidence") section = "evidence";
      else if (title === "failures" || title.includes("fail")) section = "failures";
      else if (title === "next" || title.includes("next")) section = "next";
      else section = "";
      continue;
    }
    const fieldLine = trimmed.match(/^(conclusion|evidence|failures|next)\s*:\s*(.*)$/i);
    if (fieldLine) {
      const key = fieldLine[1].toLowerCase();
      const value = fieldLine[2].trim();
      if (key === "conclusion" || key === "next") {
        section = key;
        if (value.length > 0) found[key] = cleanString(found[key] + (found[key] ? " " : "") + value);
      } else {
        section = key;
        if (value.length > 0) found[key].push(value);
      }
      continue;
    }
    if (section.length === 0) continue;
    if (section === "conclusion" || section === "next") {
      const value = cleanString(found[section] + (found[section] ? " " : "") + trimmed);
      if (value.length > 0) found[section] = value;
    } else {
      const item = trimmed.replace(/^[-*]\s*/, "");
      if (item.length > 0) found[section].push(item);
    }
  }
  return normalizeMaintenanceReport(found);
}

/** 只保留短 report 字段：禁止把 content/正文等字段带给主模型。 */
export function shortMaintenanceReport(report) {
  const normalized = normalizeMaintenanceReport(report);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  return { ok: true, report: normalized.report };
}

/**
 * 物理删除闸门：
 *   - approved === true 表示主模型已批准；
 *   - backup 必须是删除前已产生的备份引用/根；
 *   - audit 必须是删除审计入口（对象或字符串）；
 *   - executor 固定为 maintenance-subagent，approver 固定为 main-model。
 */
export function validatePhysicalDeletionRequest(request) {
  if (request === null || typeof request !== "object") {
    return { ok: false, error: "deletion: expected an object" };
  }
  const id = cleanString(request.id);
  const reason = cleanString(request.reason, 400);
  const backup = cleanString(request.backup, 500);
  const audit = request.audit === null || request.audit === undefined
    ? ""
    : typeof request.audit === "string"
      ? cleanString(request.audit, 500)
      : JSON.stringify(request.audit);
  if (request.approved !== true) {
    return { ok: false, error: "deletion denied: physical deletion requires main-model approval (approved: true)" };
  }
  if (id.length === 0) {
    return { ok: false, error: "deletion denied: target id is required" };
  }
  if (reason.length === 0) {
    return { ok: false, error: "deletion denied: reason is required for audit" };
  }
  if (typeof audit !== "string" || audit.length === 0) {
    return { ok: false, error: "deletion denied: audit entry is required" };
  }
  if (backup.length === 0) {
    return { ok: false, error: "deletion denied: backup must exist before physical deletion" };
  }
  return {
    ok: true,
    deletion: {
      id,
      reason,
      backup,
      audit,
      executor: "maintenance-subagent",
      approver: "main-model",
    },
  };
}

/** 生成一条删除审计记录（供外层在删除前/后落盘）。 */
export function newDeletionAudit({ id, reason, backupRoot, approvedBy = "main-model", at } = {}) {
  const now = typeof at === "string" && at.length > 0 ? at : new Date().toISOString();
  return {
    event: "memory/tool-physical-delete",
    at: now,
    id: cleanString(id),
    reason: cleanString(reason, 400),
    backup: cleanString(backupRoot, 500),
    approvedBy,
    executor: "maintenance-subagent",
  };
}
