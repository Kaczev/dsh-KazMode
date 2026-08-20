// kaz-agent-preset-display
// ===========================================================================
// 纯客户端显示补丁插件：修正 dsh 新对话 hero 上 agent preset 按钮的显示。
// 宿主侧只注册一个 settings 命名空间（enabled 默认 true），让 Kaz 控制面板
// 能读取/开关这个补丁插件；实际显示修正逻辑在 lib/client.js。
// ===========================================================================

import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

const NAMESPACE = settingsNamespace("kaz-agent-preset-display");

const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
});

export default {
  name: "kaz-agent-preset-display",
  apply(ctx) {
    ctx.inject(["settings"], (sctx) => {
      sctx.settings.register(NAMESPACE, SETTINGS_SCHEMA, {
        base: { enabled: true },
      });
    });
  },
};
