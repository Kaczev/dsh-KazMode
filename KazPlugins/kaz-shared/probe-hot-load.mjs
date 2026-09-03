// kaz-shared 探针：Kaz 6.0 Step 2 受控热加载判定与降级路径。
// 运行：node KazPlugins/kaz-shared/probe-hot-load.mjs
// 本探针验证判定函数本身（两种输入都有稳定降级路径）；
// 当前 DSH 的真实输入由调用方/审计脚本从运行环境读取后单独记录。
import {
  HOT_LOAD_INPUT_KEYS,
  HOT_LOAD_SUPPORTED,
  HOT_LOAD_UNSUPPORTED,
  hotLoadProbe,
  hotLoadVerdictText,
} from "./lib/hot-load-probe.js";

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

check("输入键常量齐全", Array.isArray(HOT_LOAD_INPUT_KEYS) && HOT_LOAD_INPUT_KEYS.length === 3);
const supported = hotLoadProbe({
  runtimePluginMountToolAvailable: true,
  pluginHmrAvailable: true,
  privateRegistryRegistrationSupported: true,
});
check("受控热加载支持路径返回 supported", supported.ok === true && supported.supported === true && supported.verdict === HOT_LOAD_SUPPORTED);
check("支持路径允许至多一次扩展并记录缓存代价", /at most one controlled Task Surface expansion/.test(supported.fallback) && /cache/i.test(supported.cacheCostNote));

const unsupported = hotLoadProbe({
  runtimePluginMountToolAvailable: false,
  pluginHmrAvailable: true,
  privateRegistryRegistrationSupported: false,
});
check("主面无挂载通道返回 unsupported", unsupported.ok === true && unsupported.supported === false && unsupported.verdict === HOT_LOAD_UNSUPPORTED);
check("不支持路径回退到下一任务/重启生效", /next task or after DSH restart/.test(unsupported.fallback));
check("不支持路径禁止当前 Task Surface 扩展", /do NOT expand the current Task Surface/.test(unsupported.fallback) && /no runtime Task Surface expansion/.test(unsupported.cacheCostNote));
check("缺输入保守降级为不支持", hotLoadProbe(undefined).verdict === HOT_LOAD_UNSUPPORTED);
const text = hotLoadVerdictText({ input: { runtimePluginMountToolAvailable: false, pluginHmrAvailable: false, privateRegistryRegistrationSupported: false } });
check("审计文本含 verdict/fallback/cache_cost", ["HOT_LOAD verdict=", "fallback=", "cache_cost="].every((p) => text.includes(p)));

if (failures === 0) {
  console.log("\nHOT-LOAD PROBE OK");
  process.exit(0);
} else {
  console.error(`\nHOT-LOAD PROBE FAILED: ${failures}`);
  process.exit(1);
}
