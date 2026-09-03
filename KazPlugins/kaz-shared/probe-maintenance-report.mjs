// kaz-shared 探针：Kaz 6.0 Step 2 维护子代理结构化短 report + 物理删除闸门。
// 运行：node KazPlugins/kaz-shared/probe-maintenance-report.mjs
// 验证：
//   - 维护 report 固定为 conclusion/evidence/failures/next；
//   - 主模型拿到的是短 report（不携带被维护全文）；
//   - 物理删除必须主模型批准 + 删除前备份 + 审计，缺一拒绝。
import {
  MAINTENANCE_REPORT_FIELDS,
  MAINTENANCE_REPORT_ITEM_MAX,
  MAINTENANCE_REPORT_MAX_CHARS,
  normalizeMaintenanceReport,
  maintenanceReportToText,
  parseMaintenanceReport,
  shortMaintenanceReport,
  validatePhysicalDeletionRequest,
  newDeletionAudit,
} from "./lib/maintenance-report.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

// ---------- 结构化短 report ----------
const SAMPLE = {
  conclusion: "Maintenance done: saved 1 evidence memory.",
  evidence: ["memory_save id=m-001 ok", "probe passed"],
  failures: [],
  next: "No follow-up needed.",
};
const norm = normalizeMaintenanceReport(SAMPLE);
check("字段常量固定四项", MAINTENANCE_REPORT_FIELDS.length === 4 && MAINTENANCE_REPORT_FIELDS.every((f) => Object.keys(SAMPLE).includes(f)));
check("合法 report 归一化 ok", norm.ok === true && norm.report.conclusion.length > 0);
check("evidence/failures 是数组且上限受控", Array.isArray(norm.report.evidence) && norm.report.evidence.length <= MAINTENANCE_REPORT_ITEM_MAX && Array.isArray(norm.report.failures));
check("缺 conclusion 拒绝", normalizeMaintenanceReport({ evidence: [] }).ok === false);
check("null / 数组拒绝", normalizeMaintenanceReport(null).ok === false && normalizeMaintenanceReport([]).ok === false);

// ---------- 主模型只读短 report，不重读全文 ----------
const TEXT = maintenanceReportToText(SAMPLE);
check("短 report 编码含四字段", ["Conclusion:", "Evidence:", "Failures:", "Next:"].every((prefix) => TEXT.includes(prefix)));
check("短 report 不携带 content/正文", !TEXT.includes("content_preview") && !TEXT.includes("full_body"));
check("短 report 总长有界", TEXT.length <= MAINTENANCE_REPORT_MAX_CHARS);
const parsedFromText = parseMaintenanceReport(TEXT);
check("从短文本可解析回结构", parsedFromText.ok === true && parsedFromText.report.conclusion === SAMPLE.conclusion);

const JSON_CHILD_TEXT = `The child finished. {"conclusion":"ok","evidence":["saved"],"failures":[],"next":"none"}`;
const jsonParsed = parseMaintenanceReport(JSON_CHILD_TEXT);
check("子代理 JSON 形态可解析", jsonParsed.ok === true && jsonParsed.report.evidence[0] === "saved");

const MD_CHILD_TEXT = `# Conclusion\ncleaned up\n\n## Evidence\n- e1\n- e2\n\n## Failures\nnone\n\n## Next\nnothing`;
const mdParsed = parseMaintenanceReport(MD_CHILD_TEXT);
check("子代理 Markdown 形态可解析", mdParsed.ok === true && mdParsed.report.conclusion === "cleaned up" && mdParsed.report.evidence.length === 2);

const short = shortMaintenanceReport({ conclusion: "x", evidence: [], failures: [], next: "y" });
check("shortMaintenanceReport 只返回短字段", short.ok === true && Object.keys(short.report).join(",") === MAINTENANCE_REPORT_FIELDS.join(","));

// ---------- 物理删除闸门：主模型批准 + 备份 + 审计 ----------
const deletionOk = validatePhysicalDeletionRequest({
  id: "m-001",
  reason: "outdated contract note",
  approved: true,
  backup: "kaz50-step2-xxx/memory.json.bak",
  audit: newDeletionAudit({ id: "m-001", reason: "outdated contract note", backupRoot: "kaz50-step2-xxx" }),
});
check("批准+备份+审计 的物理删除通过", deletionOk.ok === true && deletionOk.deletion.executor === "maintenance-subagent" && deletionOk.deletion.approver === "main-model");

const noApproval = validatePhysicalDeletionRequest({ id: "m-001", reason: "x", backup: "bak", audit: "audit" });
check("无主模型批准即拒绝", noApproval.ok === false && /main-model approval/.test(noApproval.error));

const noBackup = validatePhysicalDeletionRequest({ id: "m-001", reason: "x", approved: true, audit: "audit" });
check("无删除前备份即拒绝", noBackup.ok === false && /backup must exist/.test(noBackup.error));

const noAudit = validatePhysicalDeletionRequest({ id: "m-001", reason: "x", approved: true, backup: "bak" });
check("无审计入口即拒绝", noAudit.ok === false && /audit entry/.test(noAudit.error));

const audit = newDeletionAudit({ id: "m-001", reason: "outdated", backupRoot: "kaz50-step2-xxx", at: "2026-09-03T23:00:00.000Z" });
check("审计记录固定 executor=maintenance-subagent / approver=main-model", audit.executor === "maintenance-subagent" && audit.approvedBy === "main-model" && audit.event === "memory/tool-physical-delete");

if (failures === 0) {
  console.log("\nMAINTENANCE-REPORT PROBE OK");
  process.exit(0);
} else {
  console.error(`\nMAINTENANCE-REPORT PROBE FAILED: ${failures}`);
  process.exit(1);
}
