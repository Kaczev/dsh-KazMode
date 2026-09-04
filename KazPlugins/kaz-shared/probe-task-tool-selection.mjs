// kaz-shared 探针：任务分类工具选择纯函数（第三次升级）。
// 覆盖：BASE_TOOLS 内容；memory 开/关时 base 集合；MODE_SCOPED_TOOLS 固定口径；
// normalizeOptionalTools；optional 池排除 base/mode-scoped；目录排版。
// v0.8 Step B2：MODE_SCOPED_TOOLS 不再由 kaz_tool_auto_on 派生。
// 运行：node KazPlugins/kaz-shared/probe-task-tool-selection.mjs
import {
  ENABLE_TOOL,
  BASE_TOOLS,
  MODE_SCOPED_TOOLS,
  MEMORY_TOOLS,
  MEMORY_READ_TOOLS,
  KAZ_MAINTENANCE_ONLY_TOOLS,
  OPTIONAL_TOOLS_WARN_THRESHOLD,
  OPTIONAL_TOOLS_MAX,
  baseToolNames,
  normalizeOptionalTools,
  optionalToolPoolNames,
  compactOptionalToolDirectory,
  validateOptionalToolCount,
} from "./lib/tool-lists.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

check("ENABLE_TOOL 常量", ENABLE_TOOL === "enable_tool");

check(
  "BASE_TOOLS 含十个基础工具且含 enable_tool",
  Array.isArray(BASE_TOOLS) &&
    BASE_TOOLS.includes("ask_user_question") &&
    BASE_TOOLS.includes("read") &&
    BASE_TOOLS.includes("write") &&
    BASE_TOOLS.includes("edit") &&
    BASE_TOOLS.includes("glob") &&
    BASE_TOOLS.includes("grep") &&
    BASE_TOOLS.includes("pwsh") &&
    BASE_TOOLS.includes("todo_write") &&
    BASE_TOOLS.includes("web_search") &&
    BASE_TOOLS.includes(ENABLE_TOOL) &&
    BASE_TOOLS.length === 10,
);

check(
  "BASE_TOOLS 冻结且不含 memory",
  Object.isFrozen(BASE_TOOLS) && !BASE_TOOLS.some((tool) => MEMORY_TOOLS.includes(tool)),
);

{
  const off = baseToolNames({ memoryEnabled: false });
  const on = baseToolNames({ memoryEnabled: true });
  check(
    "baseToolNames memory off = BASE_TOOLS 副本",
    JSON.stringify(off) === JSON.stringify([...BASE_TOOLS]),
  );
  check(
    "baseToolNames memory on = BASE_TOOLS + 记忆读子集且不含写工具",
    [...BASE_TOOLS, ...MEMORY_READ_TOOLS].every((tool) => on.includes(tool)) &&
      on.length === BASE_TOOLS.length + MEMORY_READ_TOOLS.length &&
      !KAZ_MAINTENANCE_ONLY_TOOLS.some((tool) => on.includes(tool)),
  );
}

check(
  "MODE_SCOPED_TOOLS 固定为 Stable Main 中非 BASE_TOOLS 成员（无 exit_plan_mode）",
  !MODE_SCOPED_TOOLS.includes("exit_plan_mode") &&
    MODE_SCOPED_TOOLS.includes("create_goal") &&
    MODE_SCOPED_TOOLS.includes("get_goal") &&
    MODE_SCOPED_TOOLS.includes("update_goal") &&
    MODE_SCOPED_TOOLS.includes("whale_report") &&
    MODE_SCOPED_TOOLS.includes("subagent"),
);

check(
  "normalizeOptionalTools 空/非数组返回 []",
  JSON.stringify(normalizeOptionalTools()) === "[]" &&
    JSON.stringify(normalizeOptionalTools("safe_json_write")) === "[]" &&
    JSON.stringify(normalizeOptionalTools([])) === "[]",
);

check(
  "normalizeOptionalTools trim/去重/过滤",
  JSON.stringify(
    normalizeOptionalTools([" safe_json_write ", "", "read_image", "read_image", 42]),
  ) === JSON.stringify(["safe_json_write", "read_image"]),
);

{
  const surface = [
    ...BASE_TOOLS,
    "get_goal",
    "whale_report",
    "safe_json_write",
    "read_image",
    "job_list",
    "safe_json_write",
    "subagent",
  ];
  const pool = optionalToolPoolNames(surface, { memoryEnabled: true });
  check(
    "optional 池排除 base / mode-scoped / memory",
    pool.includes("safe_json_write") &&
      pool.includes("read_image") &&
      pool.includes("job_list") &&
      !pool.includes("enable_tool") &&
      !pool.includes("read") &&
      !pool.includes("get_goal") &&
      !pool.includes("whale_report") &&
      !pool.includes("subagent") &&
      !MEMORY_TOOLS.some((tool) => pool.includes(tool)),
  );
  check("optional 池去重且排序", JSON.stringify(pool) === JSON.stringify([...new Set(pool)].sort()));
  check("可选池不含记忆写工具（维护子代理专用）", !KAZ_MAINTENANCE_ONLY_TOOLS.some((tool) => pool.includes(tool)));
}

{
  const surface = new Set(["safe_json_write", "read", "enable_tool", "memory_save", "memory_update", "memory_forget"]);
  const pool = optionalToolPoolNames(surface);
  check("optional 池接受 Set 且默认 memory off 不把 memory 当 base", JSON.stringify(pool) === JSON.stringify(["safe_json_write"]));
  check("可选池始终过滤 memory_save/update/forget", !pool.includes("memory_save") && !pool.includes("memory_update") && !pool.includes("memory_forget"));
}

{
  const ok6 = validateOptionalToolCount(["a", "b", "c", "d", "e", "f"]);
  const warn7 = validateOptionalToolCount(["a", "b", "c", "d", "e", "f", "g"]);
  const warn8 = validateOptionalToolCount(["a", "b", "c", "d", "e", "f", "g", "h"]);
  const reject9 = validateOptionalToolCount(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  check("validateOptionalToolCount ≤6 通过", ok6.ok === true && ok6.warn === null && ok6.error === null && ok6.count === 6);
  check("validateOptionalToolCount 7/8 提醒", warn7.ok === true && warn7.warn !== null && warn8.ok === true && warn8.warn !== null && warn7.count === 7 && warn8.count === 8);
  check("validateOptionalToolCount >8 拒绝", reject9.ok === false && reject9.error !== null && reject9.count === 9);
  check("可选阈值常量唯一口径", OPTIONAL_TOOLS_WARN_THRESHOLD === 6 && OPTIONAL_TOOLS_MAX === 8);
}

{
  const directory = compactOptionalToolDirectory([
    { name: "safe_json_write", description: "Safely write JSON data to a file.\nSecond line ignored/joined." },
    { name: "read_image", description: "" },
    { name: "no_desc" },
    { name: "", description: "bad" },
    null,
  ]);
  check(
    "compactOptionalToolDirectory 一行式排版",
    directory ===
      "safe_json_write: Safely write JSON data to a file. Second line ignored/joined.\n" +
        "read_image: (no description)\n" +
        "no_desc: (no description)",
  );
}

console.log(failures === 0 ? "\nTASK-TOOL-SELECTION PROBE OK" : `\nTASK-TOOL-SELECTION PROBE FAILED (${failures} 项失败)`);
process.exit(failures === 0 ? 0 : 1);
