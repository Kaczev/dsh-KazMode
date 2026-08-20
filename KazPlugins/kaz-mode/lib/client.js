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

		/**
		 * 被管理的插件与其配置字段（字段与各插件 settings.yaml 段一一对应）。
		 * tag 作为悬停简介（Tooltip），解决名称过长被省略号截断的问题。
		 */
		const PLUGINS = [
			{
				id: "thinking-anchor",
				namespace: "thinking-anchor",
				name: "thinking-anchor",
				tag: "思考锚点 · 消息注入",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "instruction", kind: "textarea", label: "instruction（思考指令，多行；对话开始时作为消息注入）" },
					{ key: "turnReminder", kind: "textarea", label: "turnReminder（每轮思考链提醒，作为消息注入；留空 = 用内置默认）" },
				],
			},
			{
				id: "round-minimal",
				namespace: "round-minimal",
				name: "round-minimal",
				tag: "首阶段极简 · 首次工具调用后恢复",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "firstRoundTools", kind: "list", label: "firstRoundTools（首次工具调用前的工具白名单，逗号分隔）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理也走首阶段极简）" },
				],
			},
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
				tag: "输出完成提示音",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：模型输出完毕时响提示音）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理输出完毕也提示；默认关）" },
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
				tag: "DeepSeek 默认参数",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "provider", kind: "text", label: "provider（提供方路由）" },
					{ key: "model", kind: "text", label: "model（默认模型）" },
					{ key: "reasoningEffort", kind: "select", label: "reasoningEffort（默认思考强度）", options: ["low", "medium", "high"] },
					{ key: "generation_kwargs", path: ["temperature"], kind: "number", label: "temperature（采样温度；官方默认 1）" },
					{ key: "generation_kwargs", path: ["top_p"], kind: "number", label: "top_p（核采样；官方默认 1）" },
					{ key: "generation_kwargs", path: ["repetition_penalty"], kind: "number", label: "repetition_penalty（重复惩罚；官方默认 1）" },
				],
			},
			{
				id: "kaz-memory",
				namespace: "kaz-memory",
				name: "kaz-memory",
				tag: "独立记忆组件（有独立开关）",
				note: "记忆自动载入在对话开始时注入；记忆工具（memory_save/list/search/forget）仅在 kaz-memory 开启时加入 Kaz 模式的全部工具列表。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：关闭后不注入记忆、记忆工具移出 Kaz 工具面）" },
					{ key: "guidanceHead", kind: "textarea", label: "guidanceHead（固定提示总述行；留空 = 内置默认）" },
				],
			},
			{
				id: "kaz-diag",
				namespace: "kaz-diag",
				name: "kaz-diag",
				tag: "诊断 · 状态工具",
				note: "开启后 kaz_mode_status 才注册并加入 Kaz 模式的全部工具列表（与 kaz-memory 工具同款条件）。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：注册 kaz_mode_status 诊断工具）" },
				],
			},
			{
				id: "first-round-hints",
				namespace: "first-round-hints",
				name: "first-round-hints",
				tag: "首轮其它消息提示 · 对话开始注入",
				note: "对话开始时把消息作为一条合成用户消息注入一次（kaz-memory 自动载入 / thinking-anchor 同款机制）。",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：对话开始时注入消息）" },
					{ key: "message", kind: "textarea", label: "message（注入的消息内容；留空 = 内置默认 pwsh 使用要点）" },
				],
			},
		];

		/** kaz-mode 自身的面板配置字段（不提供 enabled 开关——它由预设驱动）。 */
		const KAZ_FIELDS = [
			{ key: "minimalTools", kind: "list", label: "minimalTools（工具面·极简基底：首次工具调用前保留的最小工具，逗号分隔）" },
			{ key: "toolWhitelist", kind: "list", label: "toolWhitelist（Kaz 全部工具白名单：手动增删工具就在这里改，逗号分隔；kaz-memory 关闭时其工具自动移出，kaz-diag 开启时自动加入 kaz_mode_status）" },
		];

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
.kzm-override-badge{font-size:10px;color:#b45309;border:1px solid rgba(180,83,9,.4);background:rgba(180,83,9,.08);border-radius:8px;padding:1px 6px;flex:none}
.kzm-state-item{display:flex;flex-direction:column;padding:3px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.kzm-state-item:first-of-type{border-top:none}
.kzm-state-row{display:flex;align-items:center;gap:6px}
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
.kzm-fields{display:flex;flex-direction:column;gap:8px;padding:4px 0 2px}
.kzm-preset-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.kzm-field{display:flex;flex-direction:column;gap:4px}
.kzm-field label{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.kzm-field-line{display:flex;align-items:center;gap:8px}
.kzm-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit}
.kzm-input:focus{outline:none;border-color:var(--dsw-alias-label-tertiary)}
.kzm-select{padding:4px 6px}
.kzm-textarea{min-height:64px;resize:vertical;line-height:1.5}
.kzm-error{color:#dc2626;font-size:11px;line-height:1.4}
.kzm-saving{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.kzm-drift{display:flex;align-items:center;gap:8px;border:1px solid rgba(217,119,6,.5);background:rgba(217,119,6,.08);border-radius:8px;padding:6px 10px;margin:2px 0 6px}
.kzm-drift-text{flex:1;font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.5}
.kzm-root[data-warn="true"] .kzm-dot{background:#d97706}
.kzm-root[data-side="true"] .kzm-panel{top:auto;bottom:calc(100% + 10px);left:0;right:auto}
.kzm-root[data-compact="true"] .kzm-button{width:28px;padding:0;justify-content:center}
.kzm-root[data-compact="true"] .kzm-label{display:none}
.kzm-root[data-compact="true"] .kzm-chevron{display:none}
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
			const memoryScope = bindScope("kaz-memory");

			/** 会话列表 binding（由下方 conversation/sessions inject 填充）。 */
			let sessionListBinding = null;

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

			/** 判断会话专属覆盖是否与当前模式默认设置不一致（不一致才显示“专属”）。 */
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
									commit(undefined, true); // 清空 → unset，恢复继承默认值
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
					case "number": {
						const text = draft !== null ? draft : typeof current === "number" ? String(current) : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "number",
							step: field.step || "any",
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
								commit(parsed);
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

			function PluginRow({ plugin, scope }) {
				const snap = useScope(scope);
				const value = valueOf(snap);
				const [cfgOpen, setCfgOpen] = useState(false);
				const enabled = value !== null && typeof value === "object" ? value.enabled !== false : false;
				const writable = writableOf(snap);
				const missing = value === null;

				return createElement(
					"div",
					{ className: "kzm-row" },
					createElement(
						"div",
						{ className: "kzm-row-head" },
						createElement(
							"span",
							{ className: "kzm-name", title: plugin.tag || plugin.id },
							plugin.name,
							createElement("span", { className: "kzm-tag" }, "  " + plugin.tag),
						),
						createElement(StateBadge, { state: missing ? "missing" : enabled ? "on" : "off" }),
						createElement(Toggle, {
							checked: enabled,
							onChange: (next) => {
								if (writable) scope.set("enabled", next).catch(() => {});
							},
							disabled: !writable,
							title: writable ? "单独启用 / 禁用该插件" : "当前页面不可写（远程内存模式）",
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
							plugin.fields.map((field) => createElement(FieldEditor, { key: fieldKey(field), field, scope })),
							plugin.id === "deepseek-default-model" &&
								createElement(
									"div",
									{ className: "kzm-preset-actions" },
									createElement(
										"button",
										{
											type: "button",
											className: "kzm-cfg-btn",
											disabled: !writable,
											onClick: () => {
												if (writable) scope.set("generation_kwargs", { ...DEEPSEEK_OFFICIAL_KWARGS }).catch(() => {});
											},
										},
										"使用官方值（1 / 1 / 1）",
									),
									createElement(
										"button",
										{
											type: "button",
											className: "kzm-cfg-btn",
											disabled: !writable,
											onClick: () => {
												if (writable) scope.set("generation_kwargs", { ...DEEPSEEK_KAZ_KWARGS }).catch(() => {});
											},
										},
										"使用 Kaz 模式的默认值（0.2 / 0.9 / 1.2）",
									),
								),
						),
				);
			}

			/** kaz-mode 自身行：状态由预设驱动，不提供独立 enabled 开关。 */
			function KazRow() {
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
						createElement(StateBadge, { state: kazEnabled ? "on" : "off" }),
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
						),
				);
			}

			/** 会话/默认状态字段编辑器：值来自 RPC 返回的插件状态对象，写入经
			 *  onCommit 回调转成 setSessionPlugin（编辑 a/b 也会成为当前对话专属覆盖）。 */
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
					case "number": {
						const text = draft !== null ? draft : typeof current === "number" ? String(current) : "";
						editor = createElement("input", {
							className: "kzm-input",
							type: "number",
							step: field.step || "any",
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
								commit(parsed);
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
			function StatePluginRow({ plugin, state, overridden, onPatch, disabled }) {
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
							plugin.tag !== undefined && createElement("span", { className: "kzm-tag" }, "  " + plugin.tag),
							overridden === true && createElement("span", { className: "kzm-override-badge" }, "专属"),
						),
						createElement(StateBadge, { state: missing ? "missing" : enabled ? "on" : "off" }),
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
										"使用 Kaz 模式的默认值（0.2 / 0.9 / 1.2）",
									),
								),
						),
				);
			}

			/** 三个层级的设置区块：a=非 Kaz 默认，b=Kaz 默认，c=当前对话专属。 */
			function StateSection({ title, desc, stateMap, overriddenMap, onPatch, onRestore, onSetNonKazDefault, onSetKazDefault, disabled }) {
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
								{ type: "button", className: "kzm-reset-btn", onClick: onRestore, disabled: disabled === true },
								"恢复原设置",
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
					PLUGINS.map((plugin) =>
						createElement(StatePluginRow, {
							key: plugin.id,
							plugin,
							state: stateMap !== null && stateMap !== undefined ? stateMap[plugin.id] : undefined,
							overridden: overriddenMap !== undefined && overriddenMap[plugin.id] === true,
							onPatch,
							disabled,
						}),
					),
				);
			}

			function KazPanel() {
				const kazSnap = useScope(kazScope);
				const presetSnap = useScope(presetScope);
				const kazValue = valueOf(kazSnap);
				const kazEnabled = kazValue !== null ? kazValue.enabled === true : false;
				const preset = currentPresetOf(presetSnap);
				const writable = writableOf(kazSnap);
				const { sessionId, summary } = useCurrentSession();

				const [stateData, setStateData] = useState(null);
				const refresh = useCallback(async () => {
					setStateData(null);
					const res = await rpcCall("getState", { sessionId: sessionId || "" });
					if (res !== null) setStateData(res);
				}, [sessionId]);
				useEffect(() => {
					void refresh();
				}, [refresh]);

				const defaults = stateData !== null && stateData.defaults !== undefined ? stateData.defaults : { nonKaz: {}, kaz: {} };
				const sessionOverrides = stateData !== null && stateData.session !== null && typeof stateData.session === "object" ? stateData.session : {};
				// 有会话（含空白的新建对话）就按“对话”处理：编辑会写入会话专属覆盖。
				const hasSession = summary !== null && summary !== undefined;
				const isBlank = hasSession && summary.blank === true;
				const inEstablished = hasSession && !isBlank;
				// 新建对话页面优先使用空白会话上已暂存/已应用的 agentPreset；
				// 取不到时再回退到 agent-presets.default。
				const newConversationPreset = !inEstablished && hasSession && typeof summary.agentPreset === "string"
					? summary.agentPreset
					: undefined;
				const effectiveKazEnabled = inEstablished
					? kazEnabled
					: (newConversationPreset !== undefined ? newConversationPreset === KAZ_PRESET_ID : preset === KAZ_PRESET_ID);
				const displayPreset = inEstablished ? preset : (newConversationPreset !== undefined ? newConversationPreset : preset);
				const mode = effectiveKazEnabled ? "kaz" : "nonKaz";
				const baseMap = defaults[mode] || {};
				const effectiveMap = {};
				const overriddenMap = {};
				for (const plugin of PLUGINS) {
					const base = baseMap[plugin.id] !== null && typeof baseMap[plugin.id] === "object" ? baseMap[plugin.id] : {};
					const override = sessionOverrides[plugin.id] !== null && typeof sessionOverrides[plugin.id] === "object" ? sessionOverrides[plugin.id] : {};
					effectiveMap[plugin.id] = { ...base, ...override };
					overriddenMap[plugin.id] = stateDiffers(base, override);
				}
				const hasOverrides = PLUGINS.some((plugin) => overriddenMap[plugin.id] === true);

				const patchSession = useCallback(
					async (pluginId, patch) => {
						if (!sessionId) return null;
						const res = await rpcCall("setSessionPlugin", { sessionId, pluginId, patch });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, session: res.session } : prev));
						}
						return res;
					},
					[sessionId],
				);

				const patchDefault = useCallback(
					async (targetMode, pluginId, patch, cwd) => {
						const res = await rpcCall("setDefaultPlugin", { mode: targetMode, pluginId, patch, cwd: cwd || "" });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, defaults: res.defaults } : prev));
						}
						return res;
					},
					[],
				);

				const setAsDefault = useCallback(
					async (targetMode) => {
						if (!sessionId) return null;
						const label = targetMode === "kaz" ? "Kaz" : "非 Kaz";
						if (typeof window !== "undefined" && !window.confirm("确定将当前对话设置设为" + label + "模式默认设置吗？")) return null;
						const res = await rpcCall("setAsDefault", { sessionId, mode: targetMode });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, defaults: res.defaults } : prev));
						}
						return res;
					},
					[sessionId],
				);

				const resetDefault = useCallback(
					async (targetMode, cwd) => {
						const res = await rpcCall("resetDefault", { sessionId: sessionId || "", mode: targetMode, cwd: cwd || "" });
						if (res !== null) {
							setStateData((prev) => (prev !== null ? { ...prev, defaults: res.defaults } : prev));
						}
						return res;
					},
					[sessionId],
				);

				const sessionTitle = summary !== null && summary !== undefined && typeof summary.title === "string" && summary.title.trim().length > 0
					? summary.title
					: "当前对话";

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
						"当前预设：",
						createElement("strong", null, displayPreset !== undefined ? displayPreset : "（不可读）"),
						displayPreset === KAZ_PRESET_ID ? " ← Kaz 模式" : "",
						createElement("br", null),
						"Kaz 模式跟随当前会话的预设自动开关（新对话选择模式、侧边栏切换对话时都会同步）。",
					),
					createElement(
						"p",
						{ className: "kzm-note" },
						"Kaz 模式 = 固定系统提示词（You are a helpful software engineer assistant.）+ 工具面两阶段：首次工具调用前 minimalTools ∪ round-minimal 首轮工具集，首次调用后恢复 Kaz 全部工具（minimalTools + toolWhitelist 白名单，子代理会话同样适用）；" +
							"联动插件：thinking-anchor（消息注入）+ round-minimal + plugin-filter + output-beep + round-display + deepseek-default-model + kaz-memory + kaz-diag；" +
							"kaz-memory 关闭时其工具自动移出白名单，kaz-diag 开启时 kaz_mode_status 自动加入。",
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
							? (hasSession
								? (hasOverrides
									? "当前对话专属设置会覆盖默认设置；可随时将当前设置设为默认。"
									: "当前对话与当前模式默认设置一致；修改后将变为专属设置。")
								: "正在调整新建对话的默认设置：开关会直接保存为当前模式默认值。")
							: "当前页面处于远程内存模式，设置不可写（请在本机 127.0.0.1 页面操作）。",
					),
					hasSession
						? (hasOverrides
							? createElement(StateSection, {
								key: "session-" + (sessionId || ""),
								title: sessionTitle + " 专属设置",
								desc: "当前对话的插件状态，覆盖默认设置；可直接修改，也可设为非 Kaz / Kaz 默认。",
								stateMap: effectiveMap,
								overriddenMap,
								onPatch: patchSession,
								onSetNonKazDefault: () => setAsDefault("nonKaz"),
								onSetKazDefault: () => setAsDefault("kaz"),
								disabled: !writable,
							})
							: createElement(StateSection, {
								key: "default-conv-" + mode,
								title: (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "默认设置",
								desc: "当前对话与" + (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "默认设置一致；修改后将变为专属设置。",
								stateMap: effectiveMap,
								overriddenMap,
								onPatch: patchSession,
								onRestore: () => resetDefault(mode, stateData !== null ? stateData.cwd : undefined),
								disabled: !writable,
							}))
						: createElement(StateSection, {
							key: "default-" + mode,
							title: (mode === "kaz" ? "Kaz 模式" : "非 Kaz 模式") + "下的默认设置",
							desc: mode === "kaz"
								? "新建对话若选择 Kaz 模式，将使用这里的插件状态。"
								: "新建对话若未选择 Kaz 模式，将使用这里的插件状态。",
							stateMap: mode === "kaz" ? defaults.kaz : defaults.nonKaz,
							overriddenMap,
							onPatch: (pluginId, patch) => patchDefault(mode, pluginId, patch, stateData !== null ? stateData.cwd : undefined),
							onRestore: () => resetDefault(mode, stateData !== null ? stateData.cwd : undefined),
							disabled: !writable,
						}),
					createElement(KazRow, null),
					lastRpcError.length > 0 && createElement("p", { className: "kzm-error" }, "RPC 通道未就绪：" + lastRpcError),
				);
			}

			/**
			 * Kaz 按钮：常驻侧边栏底部工具栏（root 作用域——未开始对话时同样
			 * 可见，首轮之前就能开关 / 配置八个插件，避免 Kaz 首轮极简干扰
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
				const { summary } = useCurrentSession();
				const isBlank = summary !== null && summary !== undefined && summary.blank === true;
				const inConversation = summary !== null && summary !== undefined && !isBlank;
				const newConversationPreset = !inConversation && summary !== null && typeof summary.agentPreset === "string"
					? summary.agentPreset
					: undefined;
				const effectiveKazEnabled = inConversation
					? kazEnabled
					: (newConversationPreset !== undefined ? newConversationPreset === KAZ_PRESET_ID : preset === KAZ_PRESET_ID);
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
			// 无会话（新对话 hero）或会话未记录预设时不动。
			ctx.inject(["conversation", "sessions"], (scope) => {
				sessionListBinding = {
					subscribe: (listener) => scope.sessions.list.subscribe(listener),
					getSnapshot: () => scope.sessions.list.getSnapshot(),
				};
				let lastAppliedSessionId = null;
				const sync = () => {
					const state = scope.sessions.list.getSnapshot();
					const current = state !== null && state !== undefined ? state.current : undefined;
					const summary = current !== undefined && state !== null && state.byId !== null && typeof state.byId === "object" ? state.byId[current] : undefined;
					// 只有当前会话 id 真正变化时才向宿主应用该会话的插件状态，
					// 避免 sessions 列表的频繁细碎更新导致反复写 settings.yaml。
					if (typeof current === "string" && current.length > 0 && current !== lastAppliedSessionId) {
						lastAppliedSessionId = current;
						void rpcCall("applySession", { sessionId: current });
					}
					if (summary === undefined || typeof summary.agentPreset !== "string") return;
					if (kazScope === null) return;
					const snap = kazScope.getSnapshot();
					if (!writableOf(snap)) return;
					const value = valueOf(snap);
					const enabled = value !== null && typeof value === "object" ? value.enabled === true : false;
					const next = summary.agentPreset === KAZ_PRESET_ID;
					if (enabled === next) return;
					kazScope.set("enabled", next).catch(() => {});
				};
				scope.effect(() => {
					sync();
					const stop = scope.sessions.list.subscribe(() => sync());
					return stop;
				});
			});

			// ---- 注册 ----
			// Kaz 按钮：注册进侧边栏底部工具栏（sidebar.footer.action，root 作用域、
			// 常驻可见——未开始对话时也能管理八个插件）；记忆按钮在其左侧（order -2）。
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ name: "sidebar.footer.action", id: "kaz-mode", order: -1 }, KazModeHeaderButton),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
