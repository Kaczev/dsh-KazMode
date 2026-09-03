// kaz-shared —— Kaz 6.0 Step 2 受控热加载探针（纯 ESM 判定 + 降级路径）
// ===========================================================================
// DSH 是否支持“运行时安全注册/挂载私有插件”是一个运行时事实，不写入本模块。
// 本模块只负责把探针输入收敛成可审计的结论与降级路径，避免各插件自说自话：
//   - supported=true        → 允许至多一次受控 Task Surface 扩展并记录缓存代价；
//   - supported=false       → 新工具一律“下一任务/重启后生效”，不扩展当前 Task Surface。
// 探针输入由调用方从当前 DSH 环境读取（例如 tool-cordis 是否启用、HMR 是否挂载）。
// ===========================================================================

/** 探针输入键：当前 DSH 主工具面是否暴露运行时插件挂载工具（如 tool-cordis）。 */
export const HOT_LOAD_INPUT_KEYS = Object.freeze([
  "runtimePluginMountToolAvailable",
  "pluginHmrAvailable",
  "privateRegistryRegistrationSupported",
]);

/** 稳定结论 id。 */
export const HOT_LOAD_SUPPORTED = "supported";
export const HOT_LOAD_UNSUPPORTED = "unsupported-from-main-surface";

/**
 * 受控热加载探针判定。
 * @param {object} input
 *   runtimePluginMountToolAvailable: boolean|undefined
 *   pluginHmrAvailable: boolean|undefined
 *   privateRegistryRegistrationSupported: boolean|undefined
 * @returns {object} { ok, supported, verdict, reason, fallback, cacheCostNote }
 */
export function hotLoadProbe(input) {
  const value = input !== null && typeof input === "object" ? input : {};
  const mount = value.runtimePluginMountToolAvailable === true;
  const hmr = value.pluginHmrAvailable === true;
  const registry = value.privateRegistryRegistrationSupported === true;
  const supported = mount === true && registry === true;
  if (supported) {
    return {
      ok: true,
      supported: true,
      verdict: HOT_LOAD_SUPPORTED,
      reason: "main tool surface exposes a runtime private-plugin mount channel and private registry registration is supported.",
      fallback: "permit at most one controlled Task Surface expansion; record cache/prefix invalidation cost before use.",
      cacheCostNote: "expanding Task Surface at runtime may invalidate parent KV-cache prefix; cache cost must be logged and justified.",
    };
  }
  return {
    ok: true,
    supported: false,
    verdict: HOT_LOAD_UNSUPPORTED,
    reason: `runtime plugin mount tool available=${mount}; plugin HMR available=${hmr}; private registry registration supported=${registry}.`,
    fallback: "new tools/skills take effect next task or after DSH restart; do NOT expand the current Task Surface.",
    cacheCostNote: "no runtime Task Surface expansion is permitted under the unsupported path.",
  };
}

/** 把判定结果渲染成一行式审计文本。 */
export function hotLoadVerdictText(verdict) {
  const result = hotLoadProbe(verdict?.input);
  return [
    `HOT_LOAD verdict=${result.verdict}`,
    `reason=${result.reason}`,
    `fallback=${result.fallback}`,
    `cache_cost=${result.cacheCostNote}`,
  ].join("\n");
}
