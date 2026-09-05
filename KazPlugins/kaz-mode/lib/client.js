window.__ModuleLoader__.load({
	id: "kaz-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let reactDom = require("react-dom");

		const createElement = react.createElement;
		const Fragment = react.Fragment;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;
		const useSyncExternalStore = react.useSyncExternalStore;
		const useRef = react.useRef;
		const useLayoutEffect = react.useLayoutEffect;
		const createPortal = reactDom.createPortal;

		/** Kaz 模式对应的 agent preset id（与宿主半一致）。 */
		const KAZ_PRESET_ID = "kaz";
		/** agent-presets 设置命名空间（与官方预设选择器同一个）。 */
		const PRESET_NAMESPACE = "agent-presets";

		/** deepseek-default-model 的“官方值”与“Kaz 模式默认值”预设。 */
		const DEEPSEEK_OFFICIAL_KWARGS = { temperature: 1, top_p: 1, repetition_penalty: 1 };
		const DEEPSEEK_KAZ_KWARGS = { temperature: 0.2, top_p: 0.9, repetition_penalty: 1.2 };

		/** Kaz 模式当前版本兜底值：正常会通过 RPC 读取 package.json 的 version，这里只在 RPC 失败时使用。 */
		const KAZ_CURRENT_VERSION = "3.3.0";
		/** Kaz 模式 GitHub 仓库地址。 */
		const KAZ_GITHUB_REPO_URL = "https://github.com/Kaczev/dsh-KazMode";
		/** GitHub tags API（只用来做“有没有新版本”提醒）。 */
		const KAZ_GITHUB_TAGS_API = "https://api.github.com/repos/Kaczev/dsh-KazMode/tags?per_page=100";

		/** 简单比较 tag 版本号：支持 v 前缀、点分数字（2.11.4 < 2.11.10）。 */
		function kazCompareVersions(a, b) {
			const parse = (value) =>
				String(value || "")
					.replace(/^v/i, "")
					.split(/[.\-_+]/)
					.map((part) => {
						const number = Number.parseInt(part, 10);
						return Number.isNaN(number) ? part : number;
					});
			const left = parse(a);
			const right = parse(b);
			const length = Math.max(left.length, right.length);
			for (let index = 0; index < length; index += 1) {
				const x = index < left.length ? left[index] : 0;
				const y = index < right.length ? right[index] : 0;
				if (typeof x === "number" && typeof y === "number") {
					if (x !== y) return x < y ? -1 : 1;
				} else {
					const xs = String(x ?? "");
					const ys = String(y ?? "");
					if (xs !== ys) return xs < ys ? -1 : 1;
				}
			}
			return 0;
		}

		/** 从 GitHub tags API 获取最高版本 tag；失败返回 null。 */
		async function kazFetchLatestTag() {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 10000);
				const response = await fetch(KAZ_GITHUB_TAGS_API, {
					headers: { Accept: "application/vnd.github+json" },
					signal: controller.signal,
				});
				clearTimeout(timer);
				if (!response.ok) return null;
				const data = await response.json();
				if (!Array.isArray(data) || data.length === 0) return null;
				let latest = null;
				for (const entry of data) {
					if (entry !== null && typeof entry === "object" && typeof entry.name === "string" && entry.name.length > 0) {
						if (latest === null || kazCompareVersions(entry.name, latest) > 0) latest = entry.name;
					}
				}
				return latest;
			} catch {
				return null;
			}
		}

		/**
		 * 内部插件配置定义（Kaz 5.0 Step1：仅 4 个组件显示，其余保留为内部
		 * 状态模型，面板不再渲染）。
		 */
		const ALL_PLUGINS = [
			{
				id: "plugin-filter",
				namespace: "plugin-filter",
				name: "plugin-filter",
				tag: "工具过滤（原 tool-filter）",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "mode", kind: "select", label: "mode（remove 移除 / disable 禁用）", options: ["remove", "disable"] },
					{ key: "disabledTools", kind: "list", label: "disabledTools（禁用清单，逗号分隔）" },
				],
			},
			{
				id: "output-beep",
				namespace: "output-beep",
				name: "output-beep",
				tag: "用户输入提示音",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：提问 / 提交 plan 方案时响提示音）" },
					{ key: "idleBeep", kind: "boolean", label: "idleBeep（输出完毕回到 idle 也提示；默认关）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理也提示；默认关）" },
				],
			},
			{
				id: "round-display",
				namespace: "round-display",
				name: "round-display",
				tag: "每轮注入显示",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：开启后自动判断是否显示本轮注入；关闭时完全隐藏）" },
				],
			},
			{
				id: "deepseek-default-model",
				namespace: "deepseek-default-model",
				name: "deepseek-default-model",
				tag: "DeepSeek 采样参数",
				note: "默认模型 / 思考强度（provider / model / reasoningEffort）请在 DSH 官方面板调整；本插件只管理采样参数。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "generation_kwargs", path: ["temperature"], kind: "number", step: 0.1, min: 0, max: 2, label: "temperature（采样温度；官方默认 1；范围 0~2，步长 0.1）" },
					{ key: "generation_kwargs", path: ["top_p"], kind: "number", step: 0.1, min: 0, max: 1, label: "top_p（核采样；官方默认 1；范围 0~1，步长 0.1）" },
					{ key: "generation_kwargs", path: ["repetition_penalty"], kind: "number", step: 0.1, min: 1, max: 2, label: "repetition_penalty（重复惩罚；官方默认 1；范围 1~2，步长 0.1）" },
				],
			},
			{
				id: "ka-whale-memory",
				namespace: "ka-whale-memory",
				name: "ka-whale-memory",
				tag: "独立记忆组件（有独立开关）",
				note: "记忆自动载入在对话开始时注入；六个记忆工具（memory_save/update/list/search/detail/forget）仅在 kaz-memory 开启时注册并加入工具面（关闭 = 六工具完全注销，任何模式都不再出现，热重载）。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：关闭后不注入记忆、六工具完全注销）" },
					{ key: "guidanceHeadEnabled", kind: "boolean", label: "guidanceHeadEnabled（固定提示总述行开关；默认关）" },
					{ key: "guidanceHead", kind: "textarea", label: "guidanceHead（固定提示总述行文本；仅在 guidanceHeadEnabled=true 时生效；留空 = 内置默认）" },
					{ key: "guidanceForgetEnabled", kind: "boolean", label: "guidanceForgetEnabled（遗忘指引开关；默认开）" },
					{ key: "guidanceForget", kind: "textarea", label: "guidanceForget（遗忘指引文本；仅在 guidanceForgetEnabled=true 时生效；留空 = 内置默认）" },
					{ key: "bm25", path: ["k1"], kind: "number", step: 0.1, label: "bm25.k1（BM25 词频饱和参数；默认 1.2，一般 1.2~2.0）" },
					{ key: "bm25", path: ["b"], kind: "number", step: 0.05, label: "bm25.b（BM25 长度归一化参数；默认 0.75，0 = 不做长度归一化）" },
				],
			},
			{
				id: "ka-whale-workflow",
				namespace: "ka-whale-workflow",
				name: "ka-whale-workflow",
				tag: "鲸鱼工作流 · v0.9 阶段机",
				note: "v0.9 主流程：assess-complexity → challenge-plan → decide-tools → write-plan → decide-goal → working；whale_report 固定常驻 Stable Main Surface；stage 注入与 task plan 由插件自身维护。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：关闭后不进入鲸鱼工作流）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理也走鲸鱼工作流；默认关）" },
					{ key: "skillAutoLifecycleEnabled", kind: "boolean", label: "skillAutoLifecycleEnabled（Skill 全自动生命周期总开关；默认开）" },
					{ key: "skillLifecycleUnusedDays", kind: "number", min: 1, step: 1, label: "skillLifecycleUnusedDays（未用多少天进入 retire-pending；默认 60）" },
					{ key: "skillLifecyclePendingDays", kind: "number", min: 1, step: 1, label: "skillLifecyclePendingDays（retire-pending 宽限天数；默认 7）" },
					{ key: "skillLifecycleAuditIntervalHours", kind: "number", min: 1, step: 1, label: "skillLifecycleAuditIntervalHours（后台周期审计小时数；默认 24）" },
					{ key: "skillLifecycleMaxAutoActions", kind: "number", min: 1, max: 1, step: 1, label: "skillLifecycleMaxAutoActions（每周期自动动作数；恒钳制为 1）" },
				],
			},
		];

		/** Kaz 5.0 面板保留组件：output-beep / deepseek-default-model / round-display
		 *  （kaz-agent-preset-display 作为常驻补丁单独在 PATCH_PLUGINS 显示）。
		 *  外置工具添加通道在 kaz-mode 配置区（ToolPluginsSection）中保留。 */
		const KAZ_PANEL_COMPONENT_IDS = Object.freeze(["output-beep", "deepseek-default-model", "round-display"]);
		const PLUGINS = ALL_PLUGINS.filter((plugin) => KAZ_PANEL_COMPONENT_IDS.includes(plugin.id));

		/** 常驻补丁插件：不随 Kaz/非Kaz 模式切换而关闭，专门修正 dsh 显示/体验问题。 */
		const PATCH_PLUGINS = [
			{
				id: "kaz-agent-preset-display",
				namespace: "kaz-agent-preset-display",
				name: "kaz-agent-preset-display",
				tag: "补丁插件 · 新对话预设显示修正",
				note: "常驻补丁插件：注册 conversation.hero.agentPreset，让新对话 hero 优先显示空白会话自己的 agentPreset。Kaz 模式和非 Kaz 模式下都默认开启。",
				fields: [],
			},
		];

		/** kaz-mode 自身的面板配置字段（不提供 enabled 开关——它由预设驱动）。
		 *  2026-08：官方工具已统一进“工具插件”JSON，不再在 settings.yaml 维护 toolWhitelist。 */
		const KAZ_FIELDS = [];

		/** 官方工具插件 key（fiber.name 归一化后），用于面板区分“官方/外置”。
		 *  tool-* 前缀统一按官方处理；这里再补少数不带 tool- 前缀的官方插件。 */
		const OFFICIAL_TOOL_PLUGIN_KEYS = new Set([
			"tool-pwsh",
			"tool-fs",
			"tool-fs-search",
			"tool-jobs",
			"tool-ask-user",
			"tool-todo",
			"tool-web",
			"plan-mode",
			"plan-mode-controller",
		]);
		/** Kaz 模式自家插件，排序时位于官方之上、外置之下。 */
		const KAZ_TOOL_PLUGIN_KEYS = new Set(["ka-whale-memory"]);

		/** 面板专用 RPC 通道（宿主 /kaz-mode，loopback）。 */
		const RPC_CHANNEL = "/kaz-mode";
		let rpc = null;
		let lastRpcError = "";
		async function rpcCall(endpoint, payload) {
			if (rpc === null) {
				lastRpcError = endpoint + ": RPC 客户端未创建";
				return null;
			}
			try {
				const result = await rpc.call(RPC_CHANNEL, endpoint, payload || {});
				if (result !== null && typeof result === "object" && result.ok === true) {
					lastRpcError = "";
					return result.value;
				}
				lastRpcError = endpoint + ": " + (result !== null && typeof result === "object" && result.error ? result.error.message : "RPC 返回失败");
				console.warn("[kaz-mode] rpc", endpoint, lastRpcError);
				return null;
			} catch (error) {
				lastRpcError = endpoint + ": " + (error !== null && typeof error === "object" && error.message ? error.message : String(error));
				console.warn("[kaz-mode] rpc", endpoint, error);
				return null;
			}
		}

		const inject = ["slots", "settingsScope", "connection"];

		function apply(ctx) {
			// ---- 样式（仅本插件组件的局部样式，使用 dsh 主题 token，随明暗主题） ----
			const css = `
.kzm-root{position:relative;display:inline-flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:Inter,var(--dsw-font-family)}
.kzm-button{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:1;white-space:nowrap}
.kzm-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-button:disabled{cursor:not-allowed;opacity:.6}
.kzm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.kzm-root[data-on="true"] .kzm-dot{background:#16a34a}
.kzm-root[data-on="true"] .kzm-button{border-color:rgba(22,163,74,.45)}
.kzm-chevron{color:var(--dsw-alias-label-tertiary);font-size:10px;flex:none}
.kzm-panel{position:absolute;top:calc(100% + 10px);right:0;z-index:60;width:480px;max-height:70vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 10px 30px rgb(0 0 0 / .2);padding:10px;display:flex;flex-direction:column;gap:4px;transition:opacity .16s ease,transform .16s ease}
.kzm-portal{position:fixed;z-index:1200}
.kzm-portal .kzm-panel{position:static;top:auto;bottom:auto;left:auto;right:auto;width:100%;box-sizing:border-box}
.kzm-portal.kzm-opening .kzm-panel{opacity:1;transform:translateY(0)}
.kzm-portal.kzm-closing .kzm-panel{opacity:0;transform:translateY(-6px)}
.kzm-panel-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kzm-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:2px 0 6px}
.kzm-preset{font-size:12px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));border-radius:8px;padding:6px 10px;line-height:1.5;margin:2px 0 6px}
.kzm-row{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 2px;display:flex;flex-direction:column;gap:6px}
.kzm-row:first-of-type{border-top:none}
.kzm-row-head{display:flex;align-items:center;gap:8px}
.kzm-state-section{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px;margin:2px 0;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base))}
.kzm-state-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kzm-state-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:160px}
.kzm-state-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4;width:100%}
.kzm-default-actions{display:flex;gap:6px;margin:2px 0 6px;flex-wrap:nowrap}
.kzm-default-actions .kzm-set-default-btn{flex:1;text-align:center}
.kzm-reset-btn,.kzm-set-default-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;flex:none}
.kzm-reset-btn:hover,.kzm-set-default-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-reset-btn[data-drifted="true"]{border-color:rgba(217,119,6,.65);color:#d97706;background:rgba(217,119,6,.12)}
.kzm-reset-btn[data-drifted="true"]:hover{background:rgba(217,119,6,.22)}
.kzm-override-badge{font-size:10px;color:#b45309;border:1px solid rgba(180,83,9,.4);background:rgba(180,83,9,.08);border-radius:8px;padding:1px 6px;flex:none}
.kzm-state-item{display:flex;flex-direction:column;padding:3px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.kzm-state-item:first-of-type{border-top:none}
.kzm-state-row{display:flex;align-items:center;gap:6px}
.kzm-sub-item{display:flex;flex-direction:column;gap:4px;margin-top:6px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2)}
.kzm-sub-item .kzm-state-name{color:var(--dsw-alias-label-secondary)}
.kzm-state-name{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
.kzm-name{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
.kzm-tag{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.kzm-badge{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);flex:none}
.kzm-badge[data-state="on"]{color:#16a34a;border-color:rgba(22,163,74,.45)}
.kzm-badge[data-state="missing"]{border-style:dashed}
.kzm-switch{position:relative;width:34px;height:18px;border-radius:9px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background .15s;flex:none;padding:0}
.kzm-switch[data-on="true"]{background:#16a34a}
.kzm-switch:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.kzm-switch[data-on="true"]:after{left:18px}
.kzm-switch:disabled{cursor:not-allowed;opacity:.55}
.kzm-cfg-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px;flex:none}
.kzm-cfg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-danger-btn{color:#dc2626;border-color:rgba(220,38,38,.45)}
.kzm-danger-btn:hover{background:rgba(220,38,38,.08)}
.kzm-fields{display:flex;flex-direction:column;gap:8px;padding:4px 0 2px}
.kzm-preset-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.kzm-field{display:flex;flex-direction:column;gap:4px}
.kzm-field label{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.kzm-field-line{display:flex;align-items:center;gap:8px}
.kzm-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit}
.kzm-input:focus{outline:none;border-color:var(--dsw-alias-label-tertiary)}
.kzm-select{padding:4px 6px}
.kzm-textarea{min-height:64px;resize:vertical;line-height:1.5}
.kzm-codebox{min-height:80px;resize:vertical;line-height:1.6;font-family:Consolas,Menlo,monospace;font-size:12px}
.kzm-codebox::placeholder{color:var(--dsw-alias-label-tertiary)}
.kzm-error{color:#dc2626;font-size:11px;line-height:1.4}
.kzm-saving{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.kzm-drift{display:flex;align-items:center;gap:8px;border:1px solid rgba(217,119,6,.5);background:rgba(217,119,6,.08);border-radius:8px;padding:6px 10px;margin:2px 0 6px}
.kzm-drift-text{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.5}
.kzm-root[data-warn="true"] .kzm-dot{background:#d97706}
.kzm-root[data-side="true"] .kzm-panel{top:auto;bottom:calc(100% + 10px);left:0;right:auto}
.kzm-root[data-compact="true"] .kzm-button{width:28px;padding:0;justify-content:center}
.kzm-root[data-compact="true"] .kzm-label{display:none}
.kzm-root[data-compact="true"] .kzm-chevron{display:none}
.kzm-tp-tabs{display:flex;gap:6px;margin:2px 0 8px;flex-wrap:wrap}
.kzm-tp-tab{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px}
.kzm-tp-tab[data-on="true"]{color:var(--dsw-alias-label-primary);border-color:rgba(22,163,74,.45);background:rgba(22,163,74,.08)}
.kzm-tp-add{display:flex;gap:6px;margin:2px 0 8px;flex-wrap:wrap}
.kzm-tp-group-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.04em}
.kzm-tp-tools{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));border-radius:8px;padding:6px 8px;margin:4px 0 2px;display:flex;flex-direction:column;gap:4px}
.kzm-tp-tools-title{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin:0}
`;
			const tagId = "kaz-mode/styles";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "kaz-mode";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}

			// ---- RPC 客户端初始化（宿主 /kaz-mode 通道） ----
			try {
				if (ctx.connection !== undefined && ctx.connection !== null && ctx.connection.rpc !== undefined && typeof ctx.connection.rpc.call === "function") {
					rpc = ctx.connection.rpc;
				}
			} catch {
				rpc = null;
			}

			// ---- settings 绑定：kaz-mode 自身 + agent-presets + 被管理插件 ----
			function bindScope(namespace) {
				try {
					return ctx.settingsScope.bind({ namespace });
				} catch {
					return null;
				}
			}
			const kazScope = bindScope("kaz-mode");
			const presetScope = bindScope(PRESET_NAMESPACE);
			const patchScope = bindScope("kaz-agent-preset-display");

			/** 会话列表 binding（由下方 conversation/sessions inject 填充）。 */
			let sessionListBinding = null;

			/** 广播「生效状态已变化」：kaz-memory / round-display 面板据此立即刷新显隐。
			 *  触发点：Kaz 面板状态 RPC 成功、会话联动切模式成功。 */
			function notifyEffectiveChanged() {
				if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
				try {
					window.dispatchEvent(new Event("kaz-mode:effective-changed"));
				} catch {
					// 忽略
				}
			}

			// ---- hooks ----
			const scopeBindings = new WeakMap();
			function useScope(scope) {
				if (scope === null || scope === undefined) return null;
				let binding = scopeBindings.get(scope);
				if (binding === undefined) {
					binding = {
						subscribe: (listener) => scope.subscribe(listener),
						getSnapshot: () => scope.getSnapshot(),
					};
					scopeBindings.set(scope, binding);
				}
				return useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
			}

			/** 读取当前会话（依赖 conversation/sessions inject 填充的 binding）。 */
			function useCurrentSession() {
				const binding = sessionListBinding !== null
					? sessionListBinding
					: { subscribe: () => () => {}, getSnapshot: () => null };
				const state = useSyncExternalStore(
					binding.subscribe,
					binding.getSnapshot,
					binding.getSnapshot,
				);
				const current = state !== null && typeof state === "object" ? state.current : undefined;
				const summary =
					current !== undefined && state !== null && typeof state === "object" && state.byId !== null && typeof state.byId === "object"
						? state.byId[current]
						: undefined;
				return { sessionId: typeof current === "string" ? current : null, summary: summary || null };
			}

			/** 取 settings 快照里 schema 解析后的值；未就绪返回 null。 */
			function valueOf(snap) {
				if (snap === null || snap === undefined || snap.status !== "ready") return null;
				return snap.value === undefined ? null : snap.value;
			}

			/** 判断项目专属覆盖是否与当前模式默认设置不一致（不一致才显示“专属”）。 */
			function stateDiffers(base, override) {
				if (override === null || override === undefined || typeof override !== "object") return false;
				for (const [key, value] of Object.entries(override)) {
					if (value === null || value === undefined) continue;
					const baseValue = base !== null && typeof base === "object" ? base[key] : undefined;
					if (JSON.stringify(baseValue) !== JSON.stringify(value)) return true;
				}
				return false;
			}

			function writableOf(snap) {
				return snap !== null && snap !== undefined && snap.writable === true && snap.mode === "host";
			}

			/** 字段唯一 key：嵌套字段用 “key.path0.path1” 避免同名 key 冲突。 */
			function fieldKey(field) {
				return field.key + (Array.isArray(field.path) && field.path.length > 0 ? "." + field.path.join(".") : "");
			}

			/** 按路径读取嵌套值；路径为空时返回对象本身。 */
			function getByPath(object, path) {
				let current = object;
				for (const part of path) {
					if (current === null || current === undefined || typeof current !== "object") return undefined;
					current = current[part];
				}
				return current;
			}

			/** 返回一个把 path 设为 value 的新对象（不修改原对象）。 */
			function setByPath(object, path, value) {
				if (path.length === 0) return value;
				const [head, ...rest] = path;
				const base = object !== null && typeof object === "object" && !Array.isArray(object) ? { ...object } : {};
				base[head] = setByPath(base[head], rest, value);
				return base;
			}

			/** 返回一个删除 path 后的新对象（不修改原对象）。 */
			function deleteByPath(object, path) {
				if (path.length === 0) return {};
				const [head, ...rest] = path;
				const base = object !== null && typeof object === "object" && !Array.isArray(object) ? { ...object } : {};
				if (rest.length === 0) {
					delete base[head];
				} else if (base[head] !== null && typeof base[head] === "object" && !Array.isArray(base[head])) {
					base[head] = deleteByPath(base[head], rest);
				}
				return base;
			}

			/** 当前默认 agent preset id；读不到返回 undefined。 */
			function currentPresetOf(presetSnap) {
				const value = valueOf(presetSnap);
				if (value === null || typeof value !== "object") return undefined;
				return typeof value.default === "string" ? value.default : undefined;
			}

			/**
			 * 空白会话没有显式 agentPreset 时，按会话 id 缓存“出现时捕获的默认预设”。
			 * UI 面板和会话视图联动共用同一份缓存，避免两边捕获时机不同导致显示与实际开关不一致。
			 */
			const capturedBlankPresets = new Map();
			function blankDefaultPresetFor(sessionId) {
				if (typeof sessionId !== "string" || sessionId.length === 0) return null;
				if (!capturedBlankPresets.has(sessionId)) {
					const snap = presetScope !== null ? presetScope.getSnapshot() : null;
					const captured = currentPresetOf(snap);
					if (captured === undefined) return null;
					capturedBlankPresets.set(sessionId, captured);
				}
				return capturedBlankPresets.get(sessionId);
			}

			// ---- 小组件 ----
			function Toggle({ checked, onChange, disabled, title }) {
				return createElement("button", {
					type: "button",
					className: "kzm-switch",
					"data-on": checked ? "true" : "false",
					"aria-pressed": checked ? "true" : "false",
					disabled: disabled === true,
					title: title || "",
					onClick: (event) => {
						event.stopPropagation();
						if (onChange) onChange(!checked);
					},
				});
			}

			function StateBadge({ state }) {
				const text = state === "on" ? "启用" : state === "off" ? "禁用" : "未安装";
				return createElement("span", { className: "kzm-badge", "data-state": state }, text);
			}

			/**
			 * 字段编辑器：值一律来自该插件的实时 settings 快照；写入经
			 * settingsScope.set/unset 自动同步到 settings.yaml（热重载）。
			 */
			function FieldEditor({ field, scope }) {
				const snap = useScope(scope);
				const value = valueOf(snap);
				const path = Array.isArray(field.path) ? field.path : [];
				const current = value !== null && typeof value === "object" ? getByPath(value[field.key], path) : undefined;
				const user =
					snap !== null && typeof snap === "object" && snap.user !== null && typeof snap.user === "object"
						? snap.user
						: null;
				const userCurrent = user !== null && Object.prototype.hasOwnProperty.call(user, field.key)
					? getByPath(user[field.key], path)
					: undefined;
				const writable = writableOf(snap);
				const [draft, setDraft] = useState(null);
				const [error, setError] = useState(null);
				const [saving, setSaving] = useState(false);

				const commit = (next, isUnset) => {
					if (!writable) return;
					setSaving(true);
					setError(null);
					let task;
					if (path.length === 0) {
						task = isUnset ? scope.unset(field.key) : scope.set(field.key, next);
					} else {
						const base = value !== null && typeof value === "object" && value[field.key] !== null && typeof value[field.key] === "object"
							? { ...value[field.key] }
							: {};
						const updated = isUnset ? deleteByPath(base, path) : setByPath(base, path, next);
						task = Object.keys(updated).length === 0
							? scope.unset(field.key)
							: scope.set(field.key, updated);
					}
					task
						.then(() => setDraft(null))
						.catch((err) => setError(String((err && err.message) || err)))
						.finally(() => setSaving(false));
				};

				if (value === null) {
					return createElement(
						"div",
						{ className: "kzm-field" },
						createElement("span", { className: "kzm-note" }, "配置不可用：该插件未安装或设置不可读。"),
					);
				}

				const label = createElement("label", null, field.label);

				let editor = null;
				switch (field.kind) {
					case "boolean":
						editor = createElement(
							"div",
							{ className: "kzm-field-line" },
							createElement(Toggle, {
								checked: current === true,
								onChange: (next) => commit(next),
								disabled: !writable,
							}),
						);
						break;
					case "select": {
						const selected = Array.isArray(field.options) && field.options.includes(current) ? current : field.options[0];
						editor = createElement(
							"select",
							{
								className: "kzm-input kzm-select",
								value: selected,
								disabled: !writable,
								onChange: (event) => commit(event.target.value),
							},
							field.options.map((option) => createElement("option", { key: option, value: option }, option)),
						);
						break;
					}
					case "text": {
						const text = draft !== null ? draft : typeof current === "string" ? current : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "text",
							value: text,
							disabled: !writable,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
								} else {
									commit(draft.trim());
								}
							},
						});
						break;
					}
					case "list": {
						const text = draft !== null ? draft : Array.isArray(current) ? current.join(", ") : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "text",
							value: text,
							disabled: !writable,
							placeholder: "例如：a, b, c（逗号分隔）",
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								const trimmed = draft.trim();
								if (trimmed === "") {
									if (field.nonEmpty === true) {
										setError("该列表不能为空（为空 = 首轮没有任何工具）");
										return;
									}
									commit(undefined, true); // 清空 → unset，恢复继承默认值
									return;
								}
								const parsed = trimmed
									.split(",")
									.map((part) => part.trim())
									.filter((part) => part.length > 0);
								if (field.nonEmpty === true && parsed.length === 0) {
									setError("该列表不能为空（为空 = 首轮没有任何工具）");
									return;
								}
								commit(parsed);
							},
						});
						break;
					}
					case "listarea": {
						// 多行工具清单：每行一个（也接受逗号分隔）；显示生效值（合并默认），
						// 适合长清单（如 toolWhitelist 的 31 个工具）。
						const text = draft !== null ? draft : Array.isArray(current) ? current.join("\n") : "";
						editor = createElement("textarea", {
							className: "kzm-input kzm-textarea",
							style: { minHeight: "180px", lineHeight: "1.5" },
							value: text,
							disabled: !writable,
							placeholder: "每行一个工具名（也接受逗号分隔）；留空 = 恢复默认清单",
							spellCheck: false,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								const trimmed = draft.trim();
								if (trimmed === "") {
									commit(undefined, true); // 清空 → unset，恢复继承默认值
									return;
								}
								const parsed = trimmed
									.split(/[\n,]+/)
									.map((part) => part.trim())
									.filter((part) => part.length > 0);
								commit(parsed);
							},
						});
						break;
					}
					case "textarea": {
						// 显示用户层值：没写过就是空（空 = 使用内置默认），不预填 schema 默认文案。
						const text = draft !== null ? draft : typeof userCurrent === "string" ? userCurrent : "";
						editor = createElement("textarea", {
							className: "kzm-input kzm-textarea",
							value: text,
							placeholder: "留空 = 使用内置默认",
							disabled: !writable,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
								} else {
									commit(draft);
								}
							},
						});
						break;
					}
					case "codebox": {
						// 与其它输入框同底色的代码框：逗号分隔工具清单，适合 ka-whale-workflow 重构清单。
						const text = draft !== null ? draft : Array.isArray(current) ? current.join(", ") : "";
						editor = createElement("textarea", {
							className: "kzm-input kzm-codebox",
							value: text,
							disabled: !writable,
							placeholder: "ask_user_question, read, glob, grep, web_search, memory_search, memory_list, memory_detail",
							spellCheck: false,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								const trimmed = draft.trim();
								if (trimmed === "") {
									commit(undefined, true);
									return;
								}
								const parsed = trimmed
									.split(",")
									.map((part) => part.trim())
									.filter((part) => part.length > 0);
								commit(parsed);
							},
						});
						break;
					}
					case "number": {
						const text = draft !== null ? draft : typeof current === "number" ? String(current) : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "number",
							step: field.step || "any",
							min: typeof field.min === "number" ? field.min : undefined,
							max: typeof field.max === "number" ? field.max : undefined,
							value: text,
							disabled: !writable,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
									return;
								}
								const parsed = Number(draft);
								if (!Number.isFinite(parsed)) {
									setError("必须是数字");
									return;
								}
								let value = parsed;
								if (typeof field.min === "number") value = Math.max(field.min, value);
								if (typeof field.max === "number") value = Math.min(field.max, value);
								if (value !== parsed) {
									const clampHint =
										(field.min !== undefined ? "下限 " + field.min : "") +
										(field.min !== undefined && field.max !== undefined ? "，" : "") +
										(field.max !== undefined ? "上限 " + field.max : "");
									setError("超出允许范围（" + clampHint + "），已自动截取");
									setTimeout(() => setError(null), 2500);
								}
								commit(value);
							},
						});
						break;
					}
					case "json": {
						const text = draft !== null ? draft : current === undefined ? "" : JSON.stringify(current, null, 2);
						editor = createElement(
							Fragment,
							null,
							createElement("textarea", {
								className: "kzm-input kzm-textarea",
								value: text,
								disabled: !writable,
								spellCheck: false,
								onChange: (event) => setDraft(event.target.value),
								onBlur: () => {
									if (draft === null) return;
									try {
										const parsed = JSON.parse(draft);
										commit(parsed);
									} catch (err) {
										setError("JSON 解析失败：" + String((err && err.message) || err));
									}
								},
							}),
							error !== null && createElement("span", { className: "kzm-error" }, error),
						);
						break;
					}
					default:
						editor = null;
				}

				return createElement(
					"div",
					{ className: "kzm-field" },
					label,
					editor,
					field.kind !== "json" && error !== null && createElement("span", { className: "kzm-error" }, error),
					saving && createElement("span", { className: "kzm-saving" }, "正在同步到 settings.yaml…"),
				);
			}

			/** kaz-mode 自身行：状态由预设驱动，不提供独立 enabled 开关。 */
			function KazRow({ sessionId, cwd, writable }) {
				const [cfgOpen, setCfgOpen] = useState(false);
				const kazSnap = useScope(kazScope);
				const kazValue = valueOf(kazSnap);
				const kazEnabled = kazValue !== null ? kazValue.enabled === true : false;
				return createElement(
					"div",
					{ className: "kzm-row" },
					createElement(
						"div",
						{ className: "kzm-row-head" },
						createElement(
							"span",
							{ className: "kzm-name", title: "kaz-mode" },
							"kaz-mode",
							createElement("span", { className: "kzm-tag" }, "  本插件 · 超级模式"),
						),
						createElement(
							"button",
							{
								type: "button",
								className: "kzm-cfg-btn",
								onClick: () => setCfgOpen((open) => !open),
							},
							cfgOpen ? "收起" : "配置",
						),
					),
					cfgOpen &&
						createElement(
							"div",
							{ className: "kzm-fields" },
							KAZ_FIELDS.map((field) => createElement(FieldEditor, { key: field.key, field, scope: kazScope })),
							createElement(ToolPluginsSection, {
								key: "tool-plugins",
								sessionId: sessionId || "",
								cwd,
								writable,
							}),
						),
				);
			}

			/** 项目/默认状态字段编辑器：值来自 RPC 返回的插件状态对象，写入经
			 *  onCommit 回调转成 setProjectPlugin（编辑 a/b 也会成为当前项目专属覆盖）。 */
			function StateFieldEditor({ field, state, onCommit, disabled }) {
				const path = Array.isArray(field.path) ? field.path : [];
				const current = state !== null && typeof state === "object" ? getByPath(state[field.key], path) : undefined;
				const [draft, setDraft] = useState(null);
				const [error, setError] = useState(null);
				const [saving, setSaving] = useState(false);

				const commit = (next, isUnset) => {
					if (disabled === true) return;
					setSaving(true);
					setError(null);
					let payload;
					if (path.length === 0) {
						payload = isUnset ? { [field.key]: null } : { [field.key]: next };
					} else {
						const base = state !== null && typeof state === "object" && state[field.key] !== null && typeof state[field.key] === "object"
							? { ...state[field.key] }
							: {};
						const updated = isUnset ? deleteByPath(base, path) : setByPath(base, path, next);
						payload = Object.keys(updated).length === 0
							? { [field.key]: null }
							: { [field.key]: updated };
					}
					Promise.resolve(onCommit(field.key, payload[field.key], path.length === 0 ? isUnset : false))
						.then(() => setDraft(null))
						.catch((err) => setError(String((err && err.message) || err)))
						.finally(() => setSaving(false));
				};

				const label = createElement("label", null, field.label);
				let editor = null;
				switch (field.kind) {
					case "boolean":
						editor = createElement(
							"div",
							{ className: "kzm-field-line" },
							createElement(Toggle, {
								checked: current === true,
								onChange: (next) => commit(next),
								disabled: disabled === true,
							}),
						);
						break;
					case "select": {
						const selected = Array.isArray(field.options) && field.options.includes(current) ? current : field.options[0];
						editor = createElement(
							"select",
							{
								className: "kzm-input kzm-select",
								value: selected,
								disabled: disabled === true,
								onChange: (event) => commit(event.target.value),
							},
							field.options.map((option) => createElement("option", { key: option, value: option }, option)),
						);
						break;
					}
					case "text": {
						const text = draft !== null ? draft : typeof current === "string" ? current : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "text",
							value: text,
							disabled: disabled === true,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
								} else {
									commit(draft.trim());
								}
							},
						});
						break;
					}
					case "list": {
						const text = draft !== null ? draft : Array.isArray(current) ? current.join(", ") : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "text",
							value: text,
							disabled: disabled === true,
							placeholder: "例如：a, b, c（逗号分隔）",
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								const trimmed = draft.trim();
								if (trimmed === "") {
									if (field.nonEmpty === true) {
										setError("该列表不能为空（为空 = 首轮没有任何工具）");
										return;
									}
									commit(undefined, true);
									return;
								}
								const parsed = trimmed
									.split(",")
									.map((part) => part.trim())
									.filter((part) => part.length > 0);
								if (field.nonEmpty === true && parsed.length === 0) {
									setError("该列表不能为空（为空 = 首轮没有任何工具）");
									return;
								}
								commit(parsed);
							},
						});
						break;
					}
					case "textarea": {
						const text = draft !== null ? draft : typeof current === "string" ? current : "";
						editor = createElement("textarea", {
							className: "kzm-input kzm-textarea",
							value: text,
							disabled: disabled === true,
							placeholder: "留空 = 使用内置默认",
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
								} else {
									commit(draft.trim());
								}
							},
						});
						break;
					}
					case "codebox": {
						// 与其它输入框同底色的代码框：逗号分隔工具清单，适合 ka-whale-workflow 重构清单。
						const text = draft !== null ? draft : Array.isArray(current) ? current.join(", ") : "";
						editor = createElement("textarea", {
							className: "kzm-input kzm-codebox",
							value: text,
							disabled: disabled === true,
							placeholder: "ask_user_question, read, glob, grep, web_search, memory_search, memory_list, memory_detail",
							spellCheck: false,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								const trimmed = draft.trim();
								if (trimmed === "") {
									commit(undefined, true);
									return;
								}
								const parsed = trimmed
									.split(",")
									.map((part) => part.trim())
									.filter((part) => part.length > 0);
								commit(parsed);
							},
						});
						break;
					}
					case "number": {
						const text = draft !== null ? draft : typeof current === "number" ? String(current) : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "number",
							step: field.step || "any",
							min: typeof field.min === "number" ? field.min : undefined,
							max: typeof field.max === "number" ? field.max : undefined,
							value: text,
							disabled: disabled === true,
							onChange: (event) => setDraft(event.target.value),
							onBlur: () => {
								if (draft === null) return;
								if (draft.trim() === "") {
									commit(undefined, true);
									return;
								}
								const parsed = Number(draft);
								if (!Number.isFinite(parsed)) {
									setError("必须是数字");
									return;
								}
								let value = parsed;
								if (typeof field.min === "number") value = Math.max(field.min, value);
								if (typeof field.max === "number") value = Math.min(field.max, value);
								if (value !== parsed) {
									const clampHint =
										(field.min !== undefined ? "下限 " + field.min : "") +
										(field.min !== undefined && field.max !== undefined ? "，" : "") +
										(field.max !== undefined ? "上限 " + field.max : "");
									setError("超出允许范围（" + clampHint + "），已自动截取");
									setTimeout(() => setError(null), 2500);
								}
								commit(value);
							},
						});
						break;
					}
					case "json": {
						const text = draft !== null ? draft : current === undefined ? "" : JSON.stringify(current, null, 2);
						editor = createElement(
							Fragment,
							null,
							createElement("textarea", {
								className: "kzm-input kzm-textarea",
								value: text,
								disabled: disabled === true,
								spellCheck: false,
								onChange: (event) => setDraft(event.target.value),
								onBlur: () => {
									if (draft === null) return;
									try {
										const parsed = JSON.parse(draft);
										commit(parsed);
									} catch (err) {
										setError("JSON 解析失败：" + String((err && err.message) || err));
									}
								},
							}),
							error !== null && createElement("span", { className: "kzm-error" }, error),
						);
						break;
					}
					default:
						editor = null;
				}

				return createElement(
					"div",
					{ className: "kzm-field" },
					label,
					editor,
					field.kind !== "json" && error !== null && createElement("span", { className: "kzm-error" }, error),
					saving && createElement("span", { className: "kzm-saving" }, "正在同步…"),
				);
			}

			/** 默认/会话层级中的一行插件状态（含可展开的详细配置编辑）。 */
			function StatePluginRow({ plugin, state, overridden, onPatch, onRestorePlugin, disabled }) {
				const [cfgOpen, setCfgOpen] = useState(false);
				const enabled = state !== null && typeof state === "object" ? state.enabled !== false : false;
				const missing = state === null || state === undefined;
				return createElement(
					"div",
					{ className: "kzm-state-item" },
					createElement(
						"div",
						{ className: "kzm-state-row" },
						createElement(
							"span",
							{ className: "kzm-state-name", title: plugin.tag || plugin.id },
							plugin.name,
							overridden === true && createElement("span", { className: "kzm-override-badge" }, "专属"),
							plugin.tag !== undefined && createElement("span", { className: "kzm-tag" }, "  " + plugin.tag),
						),
						missing === true && createElement(StateBadge, { state: "missing" }),
						overridden === true && onRestorePlugin !== undefined &&
							createElement(
								"button",
								{
									type: "button",
									className: "kzm-reset-btn",
									title: "清除该插件的专属设置，恢复为当前模式默认设置",
									disabled: disabled === true,
									onClick: () => onRestorePlugin(plugin.id),
								},
								"恢复默认",
							),
						createElement(Toggle, {
							checked: enabled,
							onChange: (next) => onPatch(plugin.id, { enabled: next }),
							disabled: disabled === true,
							title: plugin.tag || plugin.id,
						}),
						createElement(
							"button",
							{
								type: "button",
								className: "kzm-cfg-btn",
								onClick: () => setCfgOpen((open) => !open),
							},
							cfgOpen ? "收起" : "配置",
						),
					),
					cfgOpen &&
						createElement(
							"div",
							{ className: "kzm-fields" },
							plugin.note !== undefined && createElement("p", { className: "kzm-note" }, plugin.note),
							plugin.fields.filter((field) => field.key !== "enabled").map((field) =>
								createElement(StateFieldEditor, {
									key: fieldKey(field),
									field,
									state,
									disabled,
									onCommit: (key, next, isUnset) => {
										if (isUnset) {
											// 清空某个字段：写入 null 让宿主存 null，达到清空效果。
											return onPatch(plugin.id, { [key]: null });
										}
										return onPatch(plugin.id, { [key]: next });
									},
								}),
							),
							plugin.id === "deepseek-default-model" &&
								createElement(
									"div",
									{ className: "kzm-preset-actions" },
									createElement(
										"button",
										{
											type: "button",
											className: "kzm-cfg-btn",
											disabled: disabled === true,
											onClick: () => onPatch(plugin.id, { generation_kwargs: { ...DEEPSEEK_OFFICIAL_KWARGS } }),
										},
										"使用官方值（1 / 1 / 1）",
									),
									createElement(
										"button",
										{
											type: "button",
											className: "kzm-cfg-btn",
											disabled: disabled === true,
											onClick: () => onPatch(plugin.id, { generation_kwargs: { ...DEEPSEEK_KAZ_KWARGS } }),
										},
										"使用 Kaz 模式的默认值（0.6 / 0.95 / 1.2）",
									),
								),
						),
				);
			}

			/** 两个层级的设置区块：a=非 Kaz 默认，b=Kaz 默认，c=当前项目专属。
			 *  onRestore：区块级「恢复」按钮（默认段 = 重置该模式默认；专属段 = 清除全部项目专属覆盖）。
			 *  restoreLabel：按钮文案（默认「恢复原设置」）。onRestorePlugin：专属段里单行插件的恢复。 */
			function StateSection({ title, desc, stateMap, overriddenMap, onPatch, onRestore, onRestorePlugin, restoreLabel, onSetNonKazDefault, onSetKazDefault, disabled, plugins = PLUGINS, restoreDrifted }) {
				return createElement(
					"div",
					{ className: "kzm-state-section" },
					createElement(
						"div",
						{ className: "kzm-state-head" },
						createElement("span", { className: "kzm-state-title" }, title),
						onRestore !== undefined &&
							createElement(
								"button",
								{
									type: "button",
									className: "kzm-reset-btn",
									"data-drifted": restoreDrifted === true ? "true" : "false",
									title: restoreDrifted === true
										? "当前默认设置与代码内出厂默认不一致；点击将恢复为出厂设置"
										: (restoreLabel !== undefined ? "点击恢复默认设置" : "恢复为代码内出厂设置"),
									onClick: onRestore,
									disabled: disabled === true,
								},
								restoreLabel || "恢复原设置",
							),
					),
					createElement("p", { className: "kzm-state-desc" }, desc),
					(onSetNonKazDefault !== undefined || onSetKazDefault !== undefined) &&
						createElement(
							"div",
							{ className: "kzm-default-actions" },
							onSetNonKazDefault !== undefined &&
								createElement(
									"button",
									{ type: "button", className: "kzm-set-default-btn", onClick: onSetNonKazDefault, disabled: disabled === true },
									"设为非 Kaz 模式默认设置",
								),
							onSetKazDefault !== undefined &&
								createElement(
									"button",
									{ type: "button", className: "kzm-set-default-btn", onClick: onSetKazDefault, disabled: disabled === true },
									"设为 Kaz 模式默认设置",
								),
						),
					plugins.map((plugin) =>
						createElement(StatePluginRow, {
							key: plugin.id,
							plugin,
							state: stateMap !== null && stateMap !== undefined ? stateMap[plugin.id] : undefined,
							overridden: overriddenMap !== undefined && overriddenMap[plugin.id] === true,
							onPatch,
							onRestorePlugin,
							disabled,
						}),
					),
				);
			}

			/** 工具插件（官方 + 外置统一）管理区块：按项目分开，支持用户默认/项目设置两层。 */
			function ToolPluginsSection({ sessionId, cwd, writable }) {
				const [data, setData] = useState(null);
				const [catalog, setCatalog] = useState({ official: [...OFFICIAL_TOOL_PLUGIN_KEYS], kaz: [...KAZ_TOOL_PLUGIN_KEYS], agent: [] });
				const [busy, setBusy] = useState(false);

				const refresh = useCallback(async () => {
					setBusy(true);
					const det = await rpcCall("listToolPlugins", {});
					if (det !== null && det.catalog !== null && typeof det.catalog === "object") {
						setCatalog({
							official: Array.isArray(det.catalog.official) ? det.catalog.official : [...OFFICIAL_TOOL_PLUGIN_KEYS],
							kaz: Array.isArray(det.catalog.kaz) ? det.catalog.kaz : [...KAZ_TOOL_PLUGIN_KEYS],
							agent: Array.isArray(det.catalog.agent) ? det.catalog.agent : [],
						});
					}
					const res = await rpcCall("getExternalToolPlugins", { sessionId: sessionId || "", cwd: cwd || "" });
					if (res !== null) setData(res);
					setBusy(false);
				}, [sessionId, cwd]);

				useEffect(() => {
					void refresh();
				}, [refresh]);

				const targetCwd = () => (data !== null && typeof data.cwd === "string" && data.cwd.length > 0 ? data.cwd : cwd || "");

				const addExternalPlugin = async () => {
					const name = window.prompt("输入要添加的外置插件名（fiber.name，不是包名）");
					if (name === null || name.trim().length === 0) return;
					const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
					if (key.length === 0) return;
					const res = await rpcCall("setExternalToolPlugin", { sessionId: sessionId || "", cwd: targetCwd(), pluginName: key, addPlugin: true });
					if (res !== null) setData(res);
				};

				const addExternalToolFor = async (key) => {
					const toolName = window.prompt(`为外置插件 "${key}" 输入工具名`);
					if (toolName === null || toolName.trim().length === 0) return;
					const res = await rpcCall("setExternalToolPlugin", { sessionId: sessionId || "", cwd: targetCwd(), pluginName: key, toolName: toolName.trim(), addTool: true });
					if (res !== null) setData(res);
				};

				const addPrivateCandidate = async () => {
					const tool = window.prompt("输入私有插件候选工具名（tool）");
					if (tool === null || tool.trim().length === 0) return;
					const description = window.prompt("输入一句英文用途描述（可留空）", "");
					const source = window.prompt("输入来源路径（例如 KazPrivatePlugins/<plugin>，可留空）", "");
					const res = await rpcCall("addPrivatePluginCandidate", {
						sessionId: sessionId || "",
						cwd: targetCwd(),
						tool: tool.trim(),
						description: description === null ? "" : description.trim(),
						source: source === null ? "" : source.trim(),
						available: true,
					});
					if (res !== null && typeof res.privatePluginCandidates === "object") {
						const layers = await rpcCall("getExternalToolPlugins", { sessionId: sessionId || "", cwd: targetCwd() });
						if (layers !== null) setData(layers);
					}
				};

				if (data === null) {
					return createElement("div", { className: "kzm-state-section" }, createElement("p", { className: "kzm-note" }, "工具控制面板（当前项目）加载中…"));
				}

				const effective = data.effective !== null && typeof data.effective === "object" ? data.effective : {};
				const T0 = effective.T0 ?? {};
				const T = effective.T ?? {};
				const P = effective.P !== null && typeof effective.P === "object" ? effective.P : {};
				const userOtherEnable = data.userOtherEnable !== null && typeof data.userOtherEnable === "object" ? data.userOtherEnable : {};
				const projectOtherEnable = data.projectOtherEnable !== null && typeof data.projectOtherEnable === "object" ? data.projectOtherEnable : {};
				const userEnable = data.userEnable !== null && typeof data.userEnable === "object" ? data.userEnable : {};
				const projectEnable = data.projectEnable !== null && typeof data.projectEnable === "object" ? data.projectEnable : {};
				const agentManagedRegistry = data.agentManagedRegistry !== null && typeof data.agentManagedRegistry === "object" ? data.agentManagedRegistry : {};
				const agentManagedPlugins = agentManagedRegistry.plugins !== null && typeof agentManagedRegistry.plugins === "object" ? agentManagedRegistry.plugins : {};

				const pluginKeys = [...new Set([...Object.keys(T0), ...Object.keys(userOtherEnable), ...Object.keys(projectOtherEnable), ...Object.keys(userEnable), ...Object.keys(projectEnable), ...Object.keys(agentManagedPlugins)])].sort();
				const displayPluginKeys = pluginKeys.filter((key) => {
					const tools = Object.keys(T0[key] ?? {});
					if (tools.length > 0) return true;
					return key in userOtherEnable || key in projectOtherEnable || key in userEnable || key in projectEnable || key in agentManagedPlugins;
				});
				const categoryOf = (key) => (catalog.agent.includes(key) || key in agentManagedPlugins ? "agent" : catalog.official.includes(key) ? "official" : catalog.kaz.includes(key) ? "kaz" : "external");
				const externalKeys = displayPluginKeys.filter((key) => categoryOf(key) === "external").sort();
				const externalToolsOf = (key) => Object.keys(T0[key] ?? {}).sort();
				const pluginEnabledOf = (key) => (agentManagedPlugins[key] !== undefined && agentManagedPlugins[key] !== null ? true : P[key] === true);

				const stableMainTools = Array.isArray(data.stableMainTools) ? data.stableMainTools : [];
				const workflowTools = Array.isArray(data.workflowTools) ? data.workflowTools : [];
				const toolJobs = Array.isArray(data.toolJobs) ? data.toolJobs : [];
				const privatePluginCandidates = Array.isArray(data.privatePluginCandidates) ? data.privatePluginCandidates : [];

				const renderToolChips = (names) => createElement(
					"div",
					{ className: "kzm-field-line", style: { flexWrap: "wrap", gap: "4px" } },
					names.map((name) => createElement("span", { key: name, className: "kzm-badge", "data-state": "on", style: { cursor: "default" } }, name)),
				);

				const renderCandidateRow = (candidate) => createElement(
					"div",
					{ key: candidate.tool, className: "kzm-state-item" },
					createElement(
						"div",
						{ className: "kzm-state-row" },
						createElement("span", { className: "kzm-state-name", title: candidate.tool }, candidate.tool),
						createElement("span", { className: "kzm-badge", "data-state": candidate.available === true ? "on" : "off" }, candidate.available === true ? "available" : "candidate"),
					),
					createElement("p", { className: "kzm-note" }, (candidate.description || "(no description)") + (candidate.source ? " · " + candidate.source : "")),
				);

				const renderExternalRow = (key) => {
					const tools = externalToolsOf(key);
					const enabled = pluginEnabledOf(key);
					return createElement(
						"div",
						{ key, className: "kzm-state-item" },
						createElement(
							"div",
							{ className: "kzm-state-row" },
							createElement("span", { className: "kzm-state-name", title: key }, key),
							createElement("span", { className: "kzm-badge", "data-state": enabled ? "on" : "off", style: { cursor: "default" } }, enabled ? "候选已启用" : "候选未启用"),
							createElement("button", { type: "button", className: "kzm-cfg-btn", disabled: !writable || busy, onClick: () => void addExternalToolFor(key) }, "＋ 添加工具"),
						),
						createElement("div", { className: "kzm-field-line", style: { flexWrap: "wrap", gap: "4px" } }, tools.map((tool) => createElement("span", { key: tool, className: "kzm-badge", "data-state": "on", style: { cursor: "default" } }, tool))),
					);
				};

				return createElement(
					"div",
					{ className: "kzm-state-section" },
					createElement(
						"div",
						{ className: "kzm-state-head" },
						createElement("span", { className: "kzm-state-title" }, "工具控制面板（B4 · 只读）"),
					),
					createElement("p", { className: "kzm-state-desc" }, "Stable Main/Sub Surface 与 workflow 面由代码级固定面决定；本面板只读展示，不再提供启用/停用、删除、恢复或设为默认设置。当前项目：" + (targetCwd() || "（未知）")),
					createElement("p", { className: "kzm-tp-group-title" }, "Stable Main Surface（代码级固定 · 只读）"),
					renderToolChips(stableMainTools.length > 0 ? stableMainTools : ["(unavailable)"]),
					createElement("p", { className: "kzm-tp-group-title" }, "Workflow Carrier Tools（代码级 · 只读）"),
					renderToolChips(workflowTools.length > 0 ? workflowTools : ["(none)"]),
					createElement("p", { className: "kzm-tp-group-title" }, "tool-jobs（固定集合 · 只读）"),
					renderToolChips(toolJobs.length > 0 ? toolJobs : ["(none)"]),
					createElement("p", { className: "kzm-tp-group-title" }, "私有插件候选（查看/添加 · 不直接进主面）"),
					privatePluginCandidates.length === 0 && createElement("p", { className: "kzm-note" }, "暂无私有插件候选。"),
					privatePluginCandidates.map((candidate) => renderCandidateRow(candidate)),
					createElement("div", { className: "kzm-tp-add" }, createElement("button", { type: "button", className: "kzm-cfg-btn", disabled: !writable || busy, onClick: () => void addPrivateCandidate() }, "＋ 添加私有插件候选")),
					createElement("p", { className: "kzm-tp-group-title" }, "外置插件候选（查看/添加 · 不直接进主面）"),
					externalKeys.length === 0 && createElement("p", { className: "kzm-note" }, "暂无外置插件候选。"),
					externalKeys.map((key) => renderExternalRow(key)),
					createElement("div", { className: "kzm-tp-add" }, createElement("button", { type: "button", className: "kzm-cfg-btn", disabled: !writable || busy, onClick: () => void addExternalPlugin() }, "＋ 添加外置插件")),
					busy && createElement("p", { className: "kzm-saving" }, "正在同步…"),
				);
			}

			function KazPanel() {
				const kazSnap = useScope(kazScope);
				const presetSnap = useScope(presetScope);
				const patchSnap = useScope(patchScope);
				const kazValue = valueOf(kazSnap);
				const kazEnabled = kazValue !== null ? kazValue.enabled === true : false;
				const preset = currentPresetOf(presetSnap);
				const writable = writableOf(kazSnap);
				const patchWritable = writableOf(patchSnap);
				const patchValue = valueOf(patchSnap);
				const patchStateMap = {};
				for (const plugin of PATCH_PLUGINS) {
					patchStateMap[plugin.id] = patchValue !== null && typeof patchValue === "object" ? patchValue : {};
				}
				const patchOverriddenMap = {};
				const patchOnPatch = (pluginId, patch) => {
					if (patchScope === null || !patchWritable) return Promise.resolve(null);
					return patchScope.set("enabled", patch.enabled).catch(() => {});
				};
				const { sessionId, summary } = useCurrentSession();

				// 编辑始终按“当前项目”处理（同一项目的所有对话共享），不再按对话隔离。
				const hasSession = summary !== null && summary !== undefined;
				const isBlank = hasSession && summary.blank === true;
				const inEstablished = hasSession && !isBlank;
				// 空白会话没有显式 agentPreset 时，只在该空白会话出现时捕获一次
				// agent-presets.default；之后设置里默认预设变化不再影响当前面板。
				const blankSessionKey = !inEstablished && hasSession ? sessionId : null;
				const blankDefaultPreset = blankSessionKey !== null ? blankDefaultPresetFor(blankSessionKey) : null;

				const [stateData, setStateData] = useState(null);
				const refresh = useCallback(async () => {
					setStateData(null);
					const res = await rpcCall("getState", { sessionId: sessionId || "" });
					if (res !== null) setStateData(res);
				}, [sessionId]);
				useEffect(() => {
					void refresh();
				}, [refresh]);

				// 简单的 GitHub 新版本提醒：打开面板时查一次最新 tag。
				const [latestTag, setLatestTag] = useState(null);
				const [checkFailed, setCheckFailed] = useState(false);
				useEffect(() => {
					let cancelled = false;
					kazFetchLatestTag().then((tag) => {
						if (cancelled) return;
						if (tag === null) setCheckFailed(true);
						else setLatestTag(tag);
					});
					return () => {
						cancelled = true;
					};
				}, []);

				// 本地版本通过宿主 RPC 读取 package.json 的 version；RPC 失败时用 KAZ_CURRENT_VERSION 兜底。
				const [localVersion, setLocalVersion] = useState(null);
				useEffect(() => {
					let cancelled = false;
					rpcCall("getVersion", {}).then((res) => {
						if (cancelled) return;
						if (res !== null && typeof res.version === "string" && res.version.length > 0) {
							setLocalVersion(res.version);
						}
					});
					return () => {
						cancelled = true;
					};
				}, []);
				const effectiveLocalVersion = localVersion !== null && localVersion.length > 0 ? localVersion : KAZ_CURRENT_VERSION;

				const defaults = stateData !== null && stateData.defaults !== undefined ? stateData.defaults : { nonKaz: {}, kaz: {} };
				const projectOverrides = stateData !== null && stateData.project !== null && typeof stateData.project === "object" ? stateData.project : {};
				// 新建对话页面优先使用空白会话上已暂存/已应用的 agentPreset；
				// 取不到时用空白会话出现时捕获的默认预设（不再实时跟随设置）。
				const newConversationPreset = !inEstablished && hasSession && typeof summary.agentPreset === "string"
					? summary.agentPreset
					: undefined;
				const effectiveKazEnabled = inEstablished
					? kazEnabled
					: (newConversationPreset !== undefined ? newConversationPreset === KAZ_PRESET_ID : (blankDefaultPreset !== null ? blankDefaultPreset === KAZ_PRESET_ID : false));
				const displayPreset = inEstablished
					? (typeof summary.agentPreset === "string" ? summary.agentPreset : preset)
					: (newConversationPreset !== undefined ? newConversationPreset : (blankDefaultPreset !== null ? blankDefaultPreset : preset));
				const mode = effectiveKazEnabled ? "kaz" : "nonKaz";
				const baseMap = defaults[mode] || {};
				// 「恢复原设置」橙色提示：当前模式默认设置与代码内出厂默认（初始下载时设置）
				// 不一致时高亮，提示点击会恢复为出厂设置（getState 已返回 factory 出厂默认）。
				const factoryDefaults = stateData !== null && stateData.factory !== null && typeof stateData.factory === "object" ? stateData.factory : {};
				const factoryForMode = factoryDefaults[mode] !== null && typeof factoryDefaults[mode] === "object" ? factoryDefaults[mode] : {};
				const defaultsForMode = defaults[mode] !== null && typeof defaults[mode] === "object" ? defaults[mode] : {};
				const restoreDrifted = JSON.stringify(defaultsForMode) !== JSON.stringify(factoryForMode);
				const effectiveMap = {};
				const overriddenMap = {};
				for (const plugin of PLUGINS) {
					const base = baseMap[plugin.id] !== null && typeof baseMap[plugin.id] === "object" ? baseMap[plugin.id] : {};
					const override = projectOverrides[plugin.id] !== null && typeof projectOverrides[plugin.id] === "object" ? projectOverrides[plugin.id] : {};
					effectiveMap[plugin.id] = { ...base, ...override };
					overriddenMap[plugin.id] = stateDiffers(base, override);
				}
				const hasOverrides = PLUGINS.some((plugin) => overriddenMap[plugin.id] === true);

				const patchProject = useCallback(
					async (pluginId, patch) => {
						const cwd = stateData !== null && stateData.cwd !== undefined ? stateData.cwd : "";
						const res = await rpcCall("setProjectPlugin", { sessionId: sessionId || "", cwd, pluginId, patch });
						if (res !== null) {
							setStateData((prev) => {
								if (prev === null) return prev;
								const next = { ...(prev.project ?? {}) };
								if (res.project === null) delete next[pluginId];
								else next[pluginId] = res.project;
								return { ...prev, project: next };
							});
							notifyEffectiveChanged();
						}
						return res;
					},
					[sessionId, stateData],
				);

				const setAsDefault = useCallback(
					async (targetMode) => {
						const label = targetMode === "kaz" ? "Kaz" : "非 Kaz";
						const cwd = stateData !== null && stateData.cwd !== undefined ? stateData.cwd : "";
						if (typeof window !== "undefined" && !window.confirm("确定将当前项目设置设为" + label + "模式默认设置吗？")) return null;
						const res = await rpcCall("setAsDefault", { sessionId: sessionId || "", cwd, mode: targetMode });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, defaults: res.defaults } : prev));
							notifyEffectiveChanged();
						}
						return res;
					},
					[sessionId, stateData],
				);

				const resetDefault = useCallback(
					async (targetMode, cwd) => {
						const res = await rpcCall("resetDefault", { sessionId: sessionId || "", mode: targetMode, cwd: cwd || "" });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, defaults: res.defaults } : prev));
							notifyEffectiveChanged();
						}
						return res;
					},
					[sessionId],
				);

				// 清除当前项目的全部专属覆盖 → 回落到当前模式默认
				// （Kaz 会话回落到 Kaz 默认，非 Kaz 会话回落到非 Kaz 默认）。
				const clearProjectOverrides = useCallback(
					async () => {
						const cwd = stateData !== null && stateData.cwd !== undefined ? stateData.cwd : "";
						if (typeof window !== "undefined" && !window.confirm("确定清除当前项目的全部专属设置，恢复为当前模式默认设置吗？")) return null;
						const res = await rpcCall("clearProject", { sessionId: sessionId || "", cwd });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, project: {} } : prev));
							notifyEffectiveChanged();
						}
						return res;
					},
					[sessionId, stateData],
				);

				// 清除当前项目里单个插件的专属覆盖 → 该插件回落到当前模式默认。
				const clearProjectPluginOverride = useCallback(
					async (pluginId) => {
						const cwd = stateData !== null && stateData.cwd !== undefined ? stateData.cwd : "";
						const res = await rpcCall("clearProjectPlugin", { sessionId: sessionId || "", cwd, pluginId });
						if (res !== null) {
							setStateData((prev) => {
								if (prev === null) return prev;
								const next = { ...(prev.project ?? {}) };
								delete next[pluginId];
								return { ...prev, project: next };
							});
							notifyEffectiveChanged();
						}
						return res;
					},
					[sessionId, stateData],
				);

				return createElement(
					"div",
					{ className: "kzm-panel", role: "dialog", "aria-label": "Kaz 模式详细设置面板" },
					createElement(
						"p",
						{ className: "kzm-panel-title" },
						"Kaz 模式 · 详细设置",
						createElement("span", { className: "kzm-badge", "data-state": effectiveKazEnabled ? "on" : "off" }, effectiveKazEnabled ? "已开启" : "已关闭"),
					),
					createElement(
						"p",
						{ className: "kzm-preset" },
						createElement("strong", null, "版本"),
						"：当前 " + effectiveLocalVersion,
						latestTag !== null
							? (kazCompareVersions(effectiveLocalVersion, latestTag) < 0
								? " · GitHub 有新版本：" + latestTag
								: " · 已是最新")
							: (checkFailed ? " · GitHub 检查失败" : " · 正在检查 GitHub…"),
						createElement("br", null),
						"仓库：",
						createElement("a", { href: KAZ_GITHUB_REPO_URL, target: "_blank", rel: "noreferrer" }, KAZ_GITHUB_REPO_URL),
					),
					latestTag !== null && kazCompareVersions(effectiveLocalVersion, latestTag) < 0 &&
						createElement(
							"div",
							{ className: "kzm-drift" },
							createElement(
								"span",
								{ className: "kzm-drift-text" },
								"⚠ GitHub 有新版本：" + latestTag + "，去仓库看看更新内容吧。",
							),
						),
					createElement(
						"p",
						{ className: "kzm-preset" },
						"当前预设：",
						createElement("strong", null, displayPreset !== undefined ? displayPreset : "（不可读）"),
						displayPreset === KAZ_PRESET_ID ? " ← Kaz 模式" : "",
						createElement("br", null),
						"Kaz 模式跟随当前会话的预设自动开关（新对话选择模式、侧边栏切换对话时都会同步）。",
					),
					createElement(
						"p",
						{ className: "kzm-note" },
						"Kaz 模式 = 系统提示词由 kaz-system-prompt.mjs 收敛为 DeepSeek 基础提示词（逐字、最前；角色特化段固定放 KAZ_ROLE_PROMPTS）+ 工具面两阶段：首次工具调用前仅 KAZ_FIRST_ROUND_TOOLS（≤2），首次调用后恢复 Kaz 全部工具（工具控制面板四文件模型的生效白名单，子代理会话同样适用）；" +
							"面板保留：output-beep + deepseek-default-model + kaz-agent-preset-display + round-display（仅 Kaz）+" +
							"外置工具添加通道；ka-whale-memory 关闭时其工具自动移出白名单。",
					),
					displayPreset === KAZ_PRESET_ID &&
						effectiveKazEnabled !== true &&
						createElement(
							"div",
							{ className: "kzm-drift" },
							createElement(
								"span",
								{ className: "kzm-drift-text" },
								"⚠ 默认预设仍是 Kaz，但 Kaz 模式当前未启用——可能是某个会话切到了其它模式，或手动关闭。",
							),
						),
					createElement(
						"p",
						{ className: "kzm-note" },
						writable
							? (hasOverrides
								? "当前项目专属设置会覆盖默认设置；同一项目的所有对话共享这些设置。"
								: "当前项目与" + (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "默认设置一致；修改后将变为项目专属设置。")
							: "当前页面处于远程内存模式，设置不可写（请在本机 127.0.0.1 页面操作）。",
					),
					hasOverrides
						? createElement(StateSection, {
							key: "project-" + (stateData !== null && stateData.cwd ? stateData.cwd : "unknown"),
							title: "当前项目专属设置",
							desc: "当前项目的插件状态，覆盖默认设置；可直接修改，也可设为非 Kaz / Kaz 默认。「恢复默认设置」会清除全部项目专属覆盖，回落到当前模式默认（Kaz 对话回落到 Kaz 默认，非 Kaz 对话回落到非 Kaz 默认）。当前项目：" + (stateData !== null && stateData.cwd ? stateData.cwd : "（未知）"),
							stateMap: effectiveMap,
							overriddenMap,
							onPatch: patchProject,
							onRestore: () => clearProjectOverrides(),
							restoreLabel: "恢复默认设置",
							onRestorePlugin: (pluginId) => clearProjectPluginOverride(pluginId),
							onSetNonKazDefault: () => setAsDefault("nonKaz"),
							onSetKazDefault: () => setAsDefault("kaz"),
							disabled: !writable,
						})
						: createElement(StateSection, {
							key: "default-project-" + mode,
							title: (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "默认设置",
							desc: "当前项目与" + (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "默认设置一致；修改后将变为项目专属设置，同一项目的所有对话共享。当前项目：" + (stateData !== null && stateData.cwd ? stateData.cwd : "（未知）"),
							stateMap: effectiveMap,
							overriddenMap,
							onPatch: patchProject,
							onRestore: () => resetDefault(mode, stateData !== null ? stateData.cwd : undefined),
							restoreDrifted,
							disabled: !writable,
						}),
					createElement(StateSection, {
						key: "patch-plugins",
						title: "补丁插件（常驻）",
						desc: "这类插件修正 dsh 显示/体验问题；Kaz 模式与非 Kaz 模式下都默认开启，不随模式切换自动关闭。",
						stateMap: patchStateMap,
						overriddenMap: patchOverriddenMap,
						onPatch: patchOnPatch,
						disabled: !patchWritable,
						plugins: PATCH_PLUGINS,
					}),
					createElement(KazRow, {
						sessionId: sessionId || "",
						cwd: stateData !== null && stateData.cwd !== undefined ? stateData.cwd : undefined,
						writable,
					}),
					lastRpcError.length > 0 && createElement("p", { className: "kzm-error" }, "RPC 通道未就绪：" + lastRpcError),
				);
			}

			/**
			 * Kaz 按钮：常驻侧边栏底部工具栏（root 作用域——未开始对话时同样
			 * 可见，首轮之前就能开关 / 配置相关插件，避免 Kaz 首轮极简干扰
			 * 原生极简模式）。状态圆点与文案跟随 kaz-mode.enabled（真正的开关
			 * 状态）；点击展开 / 收起 Kaz 模式详细设置面板。
			 * 侧边栏折叠（wide=false）时只显示圆点，文案经悬停标题查看。
			 */
			function KazModeHeaderButton({ wide }) {
				const kazSnap = useScope(kazScope);
				const presetSnap = useScope(presetScope);
				const [panelOpen, setPanelOpen] = useState(false);
				const [closing, setClosing] = useState(false);
				const closeTimer = useRef(null);

				const kazValue = valueOf(kazSnap);
				const preset = currentPresetOf(presetSnap);
				const kazEnabled = kazValue !== null && kazValue.enabled === true;
				const { sessionId, summary } = useCurrentSession();
				const isBlank = summary !== null && summary !== undefined && summary.blank === true;
				const inConversation = summary !== null && summary !== undefined && !isBlank;
				// 空白会话没有显式 agentPreset 时，只在该空白会话出现时捕获一次
				// agent-presets.default；之后设置里默认预设变化不再影响当前面板。
				const blankSessionKey = !inConversation && summary !== null ? sessionId : null;
				const blankDefaultPreset = blankSessionKey !== null ? blankDefaultPresetFor(blankSessionKey) : null;
				const newConversationPreset = !inConversation && summary !== null && typeof summary.agentPreset === "string"
					? summary.agentPreset
					: undefined;
				const effectiveKazEnabled = inConversation
					? kazEnabled
					: (newConversationPreset !== undefined ? newConversationPreset === KAZ_PRESET_ID : (blankDefaultPreset !== null ? blankDefaultPreset === KAZ_PRESET_ID : preset === KAZ_PRESET_ID));
				const isKaz = preset === KAZ_PRESET_ID;
				const drifted = isKaz && !effectiveKazEnabled;
				const compact = wide === false;

				// 面板经 portal 挂到 document.body 并用 fixed 定位：侧边栏容器
				// 的 overflow 裁切曾把 absolute 面板挡住（配置按钮按不到）。
				const rootRef = useRef(null);
				const [panelPos, setPanelPos] = useState(null);

				const closePanel = useCallback(() => {
					if (!panelOpen) return;
					setClosing(true);
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
					closeTimer.current = setTimeout(() => {
						setPanelOpen(false);
						setClosing(false);
					}, 160);
				}, [panelOpen]);

				const openPanel = useCallback(() => {
					if (closeTimer.current !== null) {
						clearTimeout(closeTimer.current);
						closeTimer.current = null;
					}
					setClosing(false);
					setPanelOpen(true);
				}, []);

				useEffect(() => () => {
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				}, []);

				// 点击面板外的空白区域时平滑收起（再次点击按钮展开）。
				useEffect(() => {
					if (!panelOpen) return;
					const onMouseDown = (event) => {
						if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
						if (event.target !== null && event.target !== undefined && typeof event.target.closest === "function" && event.target.closest(".kzm-panel") !== null) return;
						closePanel();
					};
					document.addEventListener("mousedown", onMouseDown);
					return () => document.removeEventListener("mousedown", onMouseDown);
				}, [panelOpen, closePanel]);

				useLayoutEffect(() => {
					if (!panelOpen) return;
					const update = () => {
						const el = rootRef.current;
						if (el === null) return;
						const rect = el.getBoundingClientRect();
						const margin = 10;
						const width = Math.min(480, window.innerWidth - 24);
						const maxHeight = Math.min(Math.round(window.innerHeight * 0.7), 640);
						let left = rect.left;
						if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - width);
						const below = window.innerHeight - rect.bottom - margin;
						const pos = {
							left: Math.round(left) + "px",
							width: Math.round(width) + "px",
							maxHeight: maxHeight + "px",
						};
						if (below >= maxHeight || below >= rect.top) pos.top = Math.round(rect.bottom + margin) + "px";
						else pos.bottom = Math.round(window.innerHeight - rect.top + margin) + "px";
						setPanelPos(pos);
					};
					update();
					window.addEventListener("resize", update);
					return () => window.removeEventListener("resize", update);
				}, [panelOpen]);

				return createElement(
					"div",
					{
						ref: rootRef,
						className: "kzm-root",
						"data-on": effectiveKazEnabled ? "true" : "false",
						"data-warn": drifted ? "true" : "false",
						"data-side": "true",
						"data-compact": compact ? "true" : "false",
					},
					createElement(
						"button",
						{
							type: "button",
							className: "kzm-button",
							title: drifted
								? "默认预设是 Kaz，但 Kaz 模式当前未启用（某个会话切到了其它模式，或手动关闭）"
								: "打开 Kaz 模式详细设置",
							onClick: () => {
								if (panelOpen) closePanel();
								else openPanel();
							},
						},
						createElement("span", { className: "kzm-dot" }),
						createElement("span", { className: "kzm-label" }, "Kaz 模式：" + (effectiveKazEnabled ? "已开启" : "已关闭")),
						createElement("span", { className: "kzm-chevron" }, panelOpen ? "▲" : "▼"),
					),
					(panelOpen || closing) &&
						createPortal(
							createElement(
								"div",
								{
									className: "kzm-portal " + (closing ? "kzm-closing" : "kzm-opening"),
									style: panelPos !== null ? panelPos : undefined,
								},
								createElement(KazPanel, null),
							),
							document.body,
						),
				);
			}

			// ---- 会话视图联动 ----
			// 当前查看的会话预设驱动 kaz-mode.enabled：侧边栏切换对话
			// （A 会话 = Kaz、B 会话 = 极简）时自动同步开关，主机联动随之
			// 启停插件；同时通过 RPC 把当前会话的插件状态应用到宿主。
			// 空白会话没有显式 agentPreset 时，只在第一次看到这个空白会话时
			// 捕获当时的默认预设并同步一次；之后设置里默认预设变化不再影响它。
			ctx.inject(["conversation", "sessions"], (scope) => {
				sessionListBinding = {
					subscribe: (listener) => scope.sessions.list.subscribe(listener),
					getSnapshot: () => scope.sessions.list.getSnapshot(),
				};
				// 项目级专属设置按 cwd 持久化，与对话归档/删除无关，无需清理。
				let lastAppliedSessionId = null;
				const sync = () => {
					const state = scope.sessions.list.getSnapshot();
					const current = state !== null && state !== undefined ? state.current : undefined;
					const byId = state !== null && state !== undefined && state.byId !== null && typeof state.byId === "object" ? state.byId : {};
					const summary = current !== undefined ? byId[current] : undefined;
					// 会话销毁时清理 capturedBlankPresets 缓存，避免只增不减（2026-08-21）。
					for (const key of [...capturedBlankPresets.keys()]) {
						if (!Object.prototype.hasOwnProperty.call(byId, key)) capturedBlankPresets.delete(key);
					}
					// 只有当前会话 id 真正变化时才向宿主应用该会话的插件状态，
					// 避免 sessions 列表的频繁细碎更新导致反复写 settings.yaml。
					if (typeof current === "string" && current.length > 0 && current !== lastAppliedSessionId) {
						lastAppliedSessionId = current;
						// applySession 让宿主把 activeSession 指向当前会话/项目 cwd；
						// 完成后广播一次，round-display / kaz-memory 等面板会重新拉取
						// getState，避免新对话刚加载时因 agent/cwd 尚未就绪而误判显隐。
						void rpcCall("applySession", { sessionId: current }).then(() => notifyEffectiveChanged());
					}
					if (kazScope === null) return;
					const snap = kazScope.getSnapshot();
					if (!writableOf(snap)) return;

					// 已有会话 / 空白会话显式选择：以会话自己的 agentPreset 为准。
					// 空白会话没有显式 agentPreset 时，只在第一次看到这个空白会话时
					// 捕获当时的默认预设并同步一次；之后设置里默认预设变化不再影响它。
					let targetPreset;
					if (summary !== undefined && typeof summary.agentPreset === "string") {
						targetPreset = summary.agentPreset;
					} else if (typeof current === "string" && current.length > 0 && summary !== undefined && summary.blank === true) {
						const captured = blankDefaultPresetFor(current);
						if (captured === null) return; // 默认预设还没就绪，等下一次 sync
						targetPreset = captured;
					} else {
						return;
					}

					const value = valueOf(snap);
					const enabled = value !== null && typeof value === "object" ? value.enabled === true : false;
					const next = targetPreset === KAZ_PRESET_ID;
					if (enabled === next) return;
					kazScope.set("enabled", next)
						.then(() => notifyEffectiveChanged()) // 切模式后让记忆/round-display 面板刷新显隐
						.catch(() => {});
				};
				scope.effect(() => {
					sync();
					const stopSessions = scope.sessions.list.subscribe(() => sync());
					return () => {
						stopSessions();
					};
				});
			});

			// ---- 注册 ----
			// Kaz 按钮：注册进侧边栏底部工具栏（sidebar.footer.action，root 作用域、
			// 常驻可见——未开始对话时也能管理相关插件）；记忆按钮在其左侧（order -2）。
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "kaz-mode", order: -1 }, KazModeHeaderButton),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
