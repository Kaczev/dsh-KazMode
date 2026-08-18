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
		const useMemo = react.useMemo;
		const useSyncExternalStore = react.useSyncExternalStore;
		const useRef = react.useRef;
		const useLayoutEffect = react.useLayoutEffect;
		const createPortal = reactDom.createPortal;

		/** 首轮提示兜底文案（正常情况下来自 kaz-mode settings 的 firstRoundHint）。 */
		const HINT_FALLBACK = "请在第一句话中说明本次对话的总任务目标。";

		/** Kaz 模式对应的 agent preset id（与宿主半一致）。 */
		const KAZ_PRESET_ID = "kaz";
		/** agent-presets 设置命名空间（与官方预设选择器同一个）。 */
		const PRESET_NAMESPACE = "agent-presets";

		/**
		 * 被管理的八个插件与其配置字段（字段与各插件 settings.yaml 段一一对应）。
		 * 字段描述只是"编辑器元数据"：每个字段的当前值一律从该插件的实时
		 * settings 快照读取，kaz-mode 不内置任何工具列表或默认分组。
		 */
		const PLUGINS = [
			{
				id: "thinking-anchor",
				namespace: "thinking-anchor",
				name: "thinking-anchor",
				tag: "插件1 · 思考锚点",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "instruction", kind: "textarea", label: "instruction（思考指令，多行）" },
					{ key: "turnReminder", kind: "textarea", label: "turnReminder（每轮思考链提醒，首轮后每轮注入；留空 = 用内置默认）" },
				],
			},
			{
				id: "round-minimal",
				namespace: "round-minimal",
				name: "round-minimal",
				tag: "插件2 · 极简plus轮次模式",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "firstRoundTools", kind: "list", label: "firstRoundTools（首轮工具白名单，逗号分隔）" },
					{ key: "roundOneInstruction", kind: "textarea", label: "roundOneInstruction（首轮对模型的提示）" },
					{ key: "roundTwoInstruction", kind: "textarea", label: "roundTwoInstruction（第二轮过渡提示）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理也走首轮极简）" },
					{ key: "showPolicy", kind: "boolean", label: "showPolicy（轮次提示段开关；Kaz 模式期间默认被联动置为 true，退出 Kaz 时按快照恢复）" },
				],
			},
			{
				id: "tool-grouping",
				namespace: "tool-grouping",
				name: "tool-grouping",
				tag: "插件3 · 工具分组",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "registerStatusTool", kind: "boolean", label: "registerStatusTool（注册状态工具）" },
					{ key: "mode", kind: "select", label: "mode（tag 仅分组 / trace 附调用日志）", options: ["tag", "trace"] },
					{ key: "groups", kind: "json", label: "groups（分组定义，JSON 数组）" },
				],
			},
			{
				id: "tool-filter",
				namespace: "tool-filter",
				name: "tool-filter",
				tag: "插件4 · 工具过滤",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关）" },
					{ key: "mode", kind: "select", label: "mode（remove 移除 / disable 禁用）", options: ["remove", "disable"] },
					{ key: "disabledTools", kind: "list", label: "disabledTools（禁用清单，逗号分隔）" },
				],
			},
			{
				id: "code-collapse",
				namespace: "code-collapse",
				name: "code-collapse",
				tag: "插件5 · 工具塌缩 run_code",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关；工具面折叠为唯一入口 run_code）" },
					{ key: "appendCallHint", kind: "boolean", label: "appendCallHint（每次 run_code 调用后追加 We need 提示）" },
					{ key: "callHint", kind: "textarea", label: "callHint（追加的提示文案，双语信封；留空 = 内置默认）" },
					{ key: "firstRoundHint", kind: "boolean", label: "firstRoundHint（首轮注入 run_code 使用提醒；Kaz 模式默认启用）" },
					{ key: "firstRoundText", kind: "textarea", label: "firstRoundText（首轮提醒文案，[标题] / > / 内容 / <；留空 = 内置默认）" },
				],
			},
			{
				id: "output-beep",
				namespace: "output-beep",
				name: "output-beep",
				tag: "插件6 · 输出完成提示音",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：模型输出完毕时响提示音）" },
					{ key: "includeSubagents", kind: "boolean", label: "includeSubagents（子代理输出完毕也提示；默认关）" },
				],
			},
			{
				id: "task-master-whiteboard",
				namespace: "task-master-whiteboard",
				name: "task-master-whiteboard",
				tag: "插件7 · 任务白板",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：Task Master 白板工具与角色提示段）" },
					{ key: "turnReminder", kind: "textarea", label: "turnReminder（每轮白板优先提醒，第二轮起每轮注入；留空 = 内置默认）" },
				],
			},
			{
				id: "round-display",
				namespace: "round-display",
				name: "round-display",
				tag: "插件8 · 每轮注入显示",
				fields: [
					{ key: "enabled", kind: "boolean", label: "enabled（总开关：开启后自动判断是否显示本轮注入；关闭时完全隐藏）" },
				],
			},
		];

		/** kaz-mode 自身的面板配置字段（不提供 enabled 开关——它由预设驱动）。 */
		const KAZ_FIELDS = [
			{ key: "showFirstRoundHint", kind: "boolean", label: "showFirstRoundHint（显示首轮提示条）" },
			{ key: "firstRoundHint", kind: "textarea", label: "firstRoundHint（首轮提示文案，仅 UI 显示）" },
			{ key: "postFirstRoundMode", kind: "select", label: "postFirstRoundMode（首轮之后恢复的基底模式：标准 / 极简 / 创造）", options: ["standard", "minimal", "creative"] },
			{ key: "minimalTools", kind: "list", label: "minimalTools（工具面·极简基底，逗号分隔）" },
			{ key: "toolWhitelist", kind: "list", label: "toolWhitelist（工具面·白名单：逐个工具名，逗号分隔，不用组 id）" },
			{ key: "defaultDisabledPlugins", kind: "list", label: "defaultDisabledPlugins（进入 Kaz 时默认关闭的插件 id，逗号分隔；仍可在面板手动开启）" },
		];

		/** kaz-memory 的配置字段（2026-08-17 起精简）：每轮只发固定总述行，
		 *  工具细节已并入各工具描述；guidanceSearch/Save/List/Forget 保留兼容但不再生效。
		 *  旧字段 guidance（整段覆盖）保留兼容但不在面板暴露。 */
		const MEMORY_FIELDS = [
			{ key: "guidanceHead", kind: "textarea", label: "guidanceHead（固定提示总述行；留空 = 内置默认）" },
		];

		const inject = ["slots", "settingsScope"];

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
.kzm-panel{position:absolute;top:calc(100% + 10px);right:0;z-index:60;width:336px;max-height:60vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 10px 30px rgb(0 0 0 / .2);padding:10px;display:flex;flex-direction:column;gap:4px}
.kzm-portal{position:fixed;z-index:1200}
.kzm-portal .kzm-panel{position:static;top:auto;bottom:auto;left:auto;right:auto;width:100%;box-sizing:border-box}
.kzm-panel-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kzm-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:2px 0 6px}
.kzm-preset{font-size:12px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));border-radius:8px;padding:6px 10px;line-height:1.5;margin:2px 0 6px}
.kzm-row{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 2px;display:flex;flex-direction:column;gap:6px}
.kzm-row:first-of-type{border-top:none}
.kzm-row-head{display:flex;align-items:center;gap:8px}
.kzm-name{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.kzm-field{display:flex;flex-direction:column;gap:4px}
.kzm-field label{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.kzm-field-line{display:flex;align-items:center;gap:8px}
.kzm-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit}
.kzm-input:focus{outline:none;border-color:var(--dsw-alias-label-tertiary)}
.kzm-select{padding:4px 6px}
.kzm-textarea{min-height:64px;resize:vertical;line-height:1.5}
.kzm-error{color:#dc2626;font-size:11px;line-height:1.4}
.kzm-saving{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.kzm-hint{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:calc(100% - 32px);max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto 6px;padding:8px 12px;border-radius:10px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.kzm-hint-text{flex:1;min-width:0}
.kzm-hint-tag{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:1px 6px}
.kzm-hint-close{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:6px;flex:none}
.kzm-hint-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
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

			// ---- settings 绑定：kaz-mode 自身 + agent-presets + 八个被管理插件 ----
			function bindScope(namespace) {
				try {
					return ctx.settingsScope.bind({ namespace });
				} catch {
					return null;
				}
			}
			const kazScope = bindScope("kaz-mode");
			const presetScope = bindScope(PRESET_NAMESPACE);
			const pluginScopes = new Map(PLUGINS.map((plugin) => [plugin.id, bindScope(plugin.namespace)]));
			const memoryScope = bindScope("kaz-memory");

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

			/** 取 settings 快照里 schema 解析后的值；未就绪返回 null。 */
			function valueOf(snap) {
				if (snap === null || snap === undefined || snap.status !== "ready") return null;
				return snap.value === undefined ? null : snap.value;
			}

			function writableOf(snap) {
				return snap !== null && snap !== undefined && snap.writable === true && snap.mode === "host";
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
				const current = value !== null && typeof value === "object" ? value[field.key] : undefined;
				const user =
					snap !== null && typeof snap === "object" && snap.user !== null && typeof snap.user === "object"
						? snap.user
						: null;
				const userCurrent = user !== null && Object.prototype.hasOwnProperty.call(user, field.key) ? user[field.key] : undefined;
				const writable = writableOf(snap);
				const [draft, setDraft] = useState(null);
				const [error, setError] = useState(null);
				const [saving, setSaving] = useState(false);

				const commit = (next, isUnset) => {
					if (!writable) return;
					setSaving(true);
					setError(null);
					const task = isUnset ? scope.unset(field.key) : scope.set(field.key, next);
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
					case "json": {
						const text = draft !== null ? draft : JSON.stringify(current, null, 2);
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
				const kazSnap = useScope(kazScope);
				const kazValue = valueOf(kazSnap);
				const defaultOff =
					kazValue !== null &&
					Array.isArray(kazValue.defaultDisabledPlugins) &&
					kazValue.defaultDisabledPlugins.includes(plugin.id);

				return createElement(
					"div",
					{ className: "kzm-row" },
					createElement(
						"div",
						{ className: "kzm-row-head" },
						createElement(
							"span",
							{ className: "kzm-name", title: plugin.id },
							plugin.name,
							createElement("span", { className: "kzm-tag" }, "  " + plugin.tag + (defaultOff ? "  · Kaz 默认关闭" : "")),
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
							plugin.fields.map((field) => createElement(FieldEditor, { key: field.key, field, scope })),
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

			/** kaz-memory 配置行：独立记忆组件，不参与 Kaz 启停联动；有自己的 enabled
			 *  开关（Kaz 面板开关）。关闭时侧边栏「记忆」按钮与记忆面板完全不渲染、
			 *  宿主不注入指引/自动载入；本行与其它插件行一致——名称 + 徽章 + 开关 +
			 *  「配置」按钮始终显示（配置表单不受开关影响，方便随时调整 guidanceHead）。 */
			function MemoryConfigRow() {
				const [cfgOpen, setCfgOpen] = useState(false);
				const memSnap = useScope(memoryScope);
				const memValue = valueOf(memSnap);
				const missing = memValue === null;
				const enabled = memValue !== null && typeof memValue === "object" ? memValue.enabled !== false : true;
				const writable = writableOf(memSnap);
				return createElement(
					"div",
					{ className: "kzm-row" },
					createElement(
						"div",
						{ className: "kzm-row-head" },
						createElement(
							"span",
							{ className: "kzm-name", title: "kaz-memory" },
							"kaz-memory",
							createElement("span", { className: "kzm-tag" }, "  独立记忆组件（不随 Kaz 启停；有独立开关）"),
						),
						createElement(StateBadge, { state: missing ? "missing" : enabled ? "on" : "off" }),
						createElement(Toggle, {
							checked: enabled,
							onChange: (next) => {
								if (writable) memoryScope.set("enabled", next).catch(() => {});
							},
							disabled: !writable,
							title: writable ? "启用 / 禁用 kaz-memory（关闭后 UI 不显示记忆面板）" : "当前页面不可写（远程内存模式）",
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
							createElement(
								"p",
								{ className: "kzm-note" },
								"记忆指引是每轮的固定短提示（2026-08-17 起）：只发一行总述（默认 We need 风格英文），记忆工具的具体用法由各工具描述自带；仅当 memory_search 在当前环境可调用时发（存在且可直接使用或经 run_code SDK 调用），不可用时完全静默。",
							),
							MEMORY_FIELDS.map((field) => createElement(FieldEditor, { key: field.key, field, scope: memoryScope })),
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

				return createElement(
					"div",
					{ className: "kzm-panel", role: "dialog", "aria-label": "Kaz 模式详细设置面板" },
					createElement(
						"p",
						{ className: "kzm-panel-title" },
						"Kaz 模式 · 详细设置",
						createElement("span", { className: "kzm-badge", "data-state": kazEnabled ? "on" : "off" }, kazEnabled ? "已开启" : "已关闭"),
					),
					createElement(
						"p",
						{ className: "kzm-preset" },
						"当前预设：",
						createElement("strong", null, preset !== undefined ? preset : "（不可读）"),
						preset === KAZ_PRESET_ID ? " ← Kaz 模式" : "",
						createElement("br", null),
						"Kaz 模式跟随当前会话的预设自动开关（新对话选择模式、侧边栏切换对话时都会同步）。",
					),
					createElement(
						"p",
						{ className: "kzm-note" },
						"Kaz 模式 = kaz-mode 工具面（minimalTools 极简基底 + toolWhitelist 白名单，子代理会话同样适用）" +
							"+ round-minimal 首轮极简伪装（首轮提示仅 persona + thinking-anchor 两段，次轮起按 postFirstRoundMode 恢复基底）+ thinking-anchor + tool-filter + tool-grouping；" +
							"kaz-no-context 是 kaz 预设内置前置；kaz-memory 是独立定制的记忆组件（其工具组默认在白名单内）。",
					),
					preset === KAZ_PRESET_ID &&
						kazEnabled !== true &&
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
							? "所有开关与配置改动自动同步到 settings.yaml，热重载生效。"
							: "当前页面处于远程内存模式，设置不可写（请在本机 127.0.0.1 页面操作）。",
					),
					createElement(KazRow, null),
					PLUGINS.map((plugin) => createElement(PluginRow, { key: plugin.id, plugin, scope: pluginScopes.get(plugin.id) })),
					createElement(MemoryConfigRow, null),
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

				const kazValue = valueOf(kazSnap);
				const preset = currentPresetOf(presetSnap);
				const kazEnabled = kazValue !== null && kazValue.enabled === true;
				const isKaz = preset === KAZ_PRESET_ID;
				const drifted = isKaz && !kazEnabled;
				const compact = wide === false;

				// 面板经 portal 挂到 document.body 并用 fixed 定位：侧边栏容器
				// 的 overflow 裁切曾把 absolute 面板挡住（配置按钮按不到）。
				const rootRef = useRef(null);
				const [panelPos, setPanelPos] = useState(null);
				useLayoutEffect(() => {
					if (!panelOpen) return;
					const update = () => {
						const el = rootRef.current;
						if (el === null) return;
						const rect = el.getBoundingClientRect();
						const margin = 10;
						const width = Math.min(360, window.innerWidth - 24);
						const maxHeight = Math.min(Math.round(window.innerHeight * 0.6), 560);
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
						"data-on": kazEnabled ? "true" : "false",
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
							onClick: () => setPanelOpen((open) => !open),
						},
						createElement("span", { className: "kzm-dot" }),
						createElement("span", { className: "kzm-label" }, "Kaz 模式：" + (kazEnabled ? "已开启" : "已关闭")),
						createElement("span", { className: "kzm-chevron" }, panelOpen ? "▲" : "▼"),
					),
					panelOpen &&
						createPortal(
							createElement(
								"div",
								{ className: "kzm-portal", style: panelPos !== null ? panelPos : undefined },
								createElement(KazPanel, null),
							),
							document.body,
						),
				);
			}

			/**
			 * 首轮提示条：Kaz 模式开启 + 当前对话仍在首轮（无 turn/start 或
			 * 最大轮次 <= 1）+ round-minimal 启用时，显示在输入框上方。
			 * 纯 UI 提示，不进入模型提示词。
			 */
			function FirstRoundHint({ useSession }) {
				const kazSnap = useScope(kazScope);
				const rmScope = pluginScopes.get("round-minimal");
				const rmSnap = useScope(rmScope);
				const [dismissed, setDismissed] = useState(false);
				const turnTimings = useSession((session) => session.turnTimings);
				const maxTurn = useMemo(() => {
					if (!turnTimings || turnTimings.size === 0) return 0;
					let max = 0;
					turnTimings.forEach((_value, turn) => {
						if (typeof turn === "number" && turn > max) max = turn;
					});
					return max;
				}, [turnTimings]);

				const kazValue = valueOf(kazSnap);
				const rmValue = valueOf(rmSnap);
				if (dismissed) return null;
				if (kazValue === null || kazValue.enabled !== true) return null;
				if (kazValue.showFirstRoundHint === false) return null;
				if (rmValue === null || rmValue.enabled === false) return null;
				if (maxTurn > 1) return null;

				const text =
					typeof kazValue.firstRoundHint === "string" && kazValue.firstRoundHint.trim().length > 0
						? kazValue.firstRoundHint
						: HINT_FALLBACK;

				return createElement(
					"div",
					{ className: "kzm-hint" },
					createElement("span", { className: "kzm-hint-tag" }, "Kaz 模式 · 首轮"),
					createElement("span", { className: "kzm-hint-text" }, text),
					createElement(
						"button",
						{
							type: "button",
							className: "kzm-hint-close",
							title: "关闭本条提示",
							onClick: () => setDismissed(true),
						},
						"×",
					),
				);
			}

			// ---- 会话视图联动 ----
			// 当前查看的会话预设驱动 kaz-mode.enabled：侧边栏切换对话
			// （A 会话 = Kaz、B 会话 = 极简）时自动同步开关，主机联动随之
			// 启停八个插件。无会话（新对话 hero）或会话未记录预设时不动。
			ctx.inject(["conversation", "sessions"], (scope) => {
				const sync = () => {
					const state = scope.sessions.list.getSnapshot();
					const summary = state !== null && state !== undefined && state.current !== undefined ? state.byId[state.current] : undefined;
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
			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register({ name: "conversation.input.dock", id: "kaz-first-round-hint", order: 100 }, FirstRoundHint),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
