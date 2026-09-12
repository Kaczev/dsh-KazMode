// ka-whale-memory —— environment 记忆（第三种 kind）。
//
// 与 context / paths 的本质区别：
//   * 存法不同：context / paths 是"一个记忆一个 JSON、按 name 命名、分目录"；environment
//     是**一个 location 一个固定文件** `environment.json`，没有目录、不按名字命名。
//   * 用途不同：environment 由 `kaz-environment` 注入系统提示（persona 之下、官方工具提示之上，
//     见 agent.cordis.yml），context / paths 只经记忆工具读取。
//   * 因此 **environment 不进 KINDS**（不让它去枚举目录），也不经 memory_search / memory_list /
//     memory_detail 暴露：它的内容只出现在系统提示里。
//
// 写入只走 memory_save / memory_update（kind = environment）；写盘用临时文件 + rename（原子替换）。

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_ENVIRONMENT_NAME, environmentFilePath } from "./paths.js";

/** 读出某个 location 的 environment 记忆；没有或损坏返回 null。 */
export async function readEnvironment(location, cwd) {
  const file = environmentFilePath(location, cwd);
  try {
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object") return null;
    if (typeof data.environment !== "string" || data.environment.length === 0) return null;
    return {
      location,
      name: typeof data.name === "string" && data.name.length > 0 ? data.name : DEFAULT_ENVIRONMENT_NAME,
      body: data.environment,
      file,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    };
  } catch {
    return null;
  }
}

/** 写某个 location 的 environment 记忆（固定文件名；name 仅作账本记录，缺省用 environment）。 */
export async function writeEnvironment(location, name, body, cwd) {
  const file = environmentFilePath(location, cwd);
  await fs.mkdir(dirname(file), { recursive: true });
  const data = {
    location,
    name: typeof name === "string" && name.trim().length > 0 ? name.trim() : DEFAULT_ENVIRONMENT_NAME,
    environment: body,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}
