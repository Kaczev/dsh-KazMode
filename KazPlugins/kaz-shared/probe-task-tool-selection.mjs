// kaz-shared 探针：任务分类工具选择纯函数（第三次升级）。
// 覆盖：BASE_TOOLS 内容；memory 开/关时 base 集合；MODE_SCOPED_TOOLS 派生；
// normalizeOptionalTools；optional 池排除 base/mode-scoped；目录排版。
// 运行：node KazPlugins/kaz-shared/probe-task-tool-selection.mjs
import {
  ENABLE_TOOL,
  BASE_TOOLS,
  MODE_SCOPED_TOOLS,
  MEMORY_TOOLS,
  baseToolNames,
  normalizeOptionalTools,
  optionalToolPoolNames,
  compactOptionalToolDirectory,
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
    "baseToolNames memory on = BASE_TOOLS + MEMORY_TOOLS",
    [...BASE_TOOLS, ...MEMORY_TOOLS].every((tool) => on.includes(tool)) &&
      on.length === BASE_TOOLS.length + MEMORY_TOOLS.length,
  );
}

check(
  "MODE_SCOPED_TOOLS 从 auto-on 派生且含模式工具",
  MODE_SCOPED_TOOLS.includes("exit_plan_mode") &&
    MODE_SCOPED_TOOLS.includes("get_goal") &&
    MODE_SCOPED_TOOLS.includes("update_goal") &&
    MODE_SCOPED_TOOLS.includes("whale_report"),
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
    "exit_plan_mode",
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
      pool.includes("subagent") &&
      !pool.includes("enable_tool") &&
      !pool.includes("read") &&
      !pool.includes("exit_plan_mode") &&
      !pool.includes("get_goal") &&
      !pool.includes("whale_report") &&
      !MEMORY_TOOLS.some((tool) => pool.includes(tool)),
  );
  check("optional 池去重且排序", JSON.stringify(pool) === JSON.stringify([...new Set(pool)].sort()));
}

{
  const surface = new Set(["safe_json_write", "read", "enable_tool", "exit_plan_mode"]);
  const pool = optionalToolPoolNames(surface);
  check("optional 池接受 Set 且默认 memory off 不把 memory 当 base", JSON.stringify(pool) === JSON.stringify(["safe_json_write"]));
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
