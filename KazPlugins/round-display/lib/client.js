window.__ModuleLoader__.load({
	id: "round-display",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let reactDom = require("react-dom");

		const createElement = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;
		const useRef = react.useRef;
		const useLayoutEffect = react.useLayoutEffect;
		const useSyncExternalStore = react.useSyncExternalStore;
		const createPortal = reactDom.createPortal;

		/** 宿主注册的专用 RPC 通道（注入记录不经过 settings.yaml）。 */
		const RPC_CHANNEL = "/round-display";

		const inject = ["slots", "connection", "settingsScope"];

		function apply(ctx) {
			// ---- 局部样式（随 dsh 主题） ----
			const css = ".rd-root{position:relative;display:inline-flex;flex-direction:column;align-items:flex-end;font-family:Inter,var(--dsw-font-family)}\n.rd-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:1;white-space:nowrap}\n.rd-button:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.rd-button[data-open=\"true\"]{border-color:var(--dsw-alias-label-tertiary)}\n.rd-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}\n.rd-root[data-count=\"true\"] .rd-dot{background:#16a34a}\n.rd-chevron{color:var(--dsw-alias-label-tertiary);font-size:10px;flex:none}\n.rd-portal{position:fixed;z-index:1300}\n.rd-portal .rd-panel{position:static;top:auto;bottom:auto;left:auto;right:auto;width:100%;box-sizing:border-box}\n.rd-panel{max-height:70vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 10px 30px rgb(0 0 0 / .2);padding:10px;display:flex;flex-direction:column;gap:8px;transition:opacity .16s ease,transform .16s ease}\n.rd-portal.rd-opening .rd-panel{opacity:1;transform:translateY(0)}\n.rd-portal.rd-closing .rd-panel{opacity:0;transform:translateY(-6px)}\n.rd-panel-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}\n.rd-badge{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);flex:none}\n.rd-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:2px 0 4px}\n.rd-group{border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;display:flex;flex-direction:column;gap:4px}\n.rd-group:first-of-type{border-top:none;padding-top:0}\n.rd-group-head{display:flex;align-items:center;gap:8px}\n.rd-plugin{font-size:11px;color:#8b5cf6;border:1px solid rgba(139,92,246,.5);border-radius:8px;padding:1px 6px;flex:none;font-weight:600}\n.rd-turn{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;text-align:right}\n.rd-content{font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.6;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));margin:0}.rd-entry{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}.rd-entry-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.rd-entry-title{font-size:11px;color:var(--dsw-alias-label-tertiary)}.rd-plugin-unknown{color:#dc2626;border-color:rgba(220,38,38,.5)}\n.rd-act{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px}\n.rd-act:hover{background:var(--dsw-alias-interactive-bg-hover)}\n.rd-act:disabled{cursor:not-allowed;opacity:.55}\n.rd-tab{display:flex;gap:4px;margin:0}\n.rd-tab-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px}\n.rd-tab-btn[data-on=\"true\"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}\n";
			const tagId = "round-display/styles";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "round-display";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}

			// ---- 专用 RPC 客户端（宿主 /round-display 通道，注入记录不经过 settings） ----
			let rpc = null;
			let lastRpcError = "";
			try {
				if (ctx.connection !== undefined && ctx.connection !== null && ctx.connection.rpc !== undefined && typeof ctx.connection.rpc.call === "function") {
					rpc = ctx.connection.rpc;
				}
			} catch {
				rpc = null;
			}
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
					console.warn("[round-display] rpc", endpoint, lastRpcError);
					return null;
				} catch (error) {
					lastRpcError = endpoint + ": " + (error !== null && typeof error === "object" && error.message ? error.message : String(error));
					console.warn("[round-display] rpc", endpoint, error);
					return null;
				}
			}

			// ---- 会话显隐（纯方案 A）：优先用 kaz-mode getState 的 effective（与
			// Kaz 面板同源：模式默认 + 会话覆盖），取不到时回退 settings.yaml 开关。----
			/** 经 kaz-mode RPC 读取某会话的完整状态（与 Kaz 面板同源）；失败返回 null。 */
			async function kazModeGetState(sessionId) {
				if (rpc === null) return null;
				try {
					const result = await rpc.call("/kaz-mode", "getState", { sessionId: sessionId || "" });
					if (result !== null && typeof result === "object" && result.ok === true && result.value !== null && typeof result.value === "object") {
						return result.value;
					}
					return null;
				} catch {
					return null;
				}
			}

			/** 读 getState 里 host 已算好的生效 enabled（state.effective[pluginId].enabled）。 */
			function effectiveEnabledOf(state, pluginId) {
				if (state === null || state === undefined || typeof state !== "object") return null;
				const eff = state.effective !== null && typeof state.effective === "object" ? state.effective : {};
				const entry = eff[pluginId];
				if (entry === null || entry === undefined || typeof entry !== "object") return null;
				return entry.enabled !== false;
			}

			/** 当前会话 id：引用不变的 store（组件挂载后再注入也不丢订阅），
			 *  由下方 ctx.inject(["sessions"]) 填充。 */
			const sessionIdStore = {
				listeners: new Set(),
				value: "",
				subscribe(listener) {
					this.listeners.add(listener);
					return () => this.listeners.delete(listener);
				},
				getSnapshot() {
					return this.value;
				},
				set(next) {
					const v = typeof next === "string" ? next : "";
					if (v !== this.value) {
						this.value = v;
						for (const l of [...this.listeners]) l();
					}
				},
			};
			function useCurrentSessionId() {
				return useSyncExternalStore(
					(listener) => sessionIdStore.subscribe(listener),
					() => sessionIdStore.getSnapshot(),
					() => sessionIdStore.getSnapshot(),
				);
			}

			// ---- settings 绑定：round-display.enabled（standalone 兜底开关，热重载） ----
			let rdScope = null;
			try {
				if (ctx.settingsScope !== undefined && ctx.settingsScope !== null && typeof ctx.settingsScope.bind === "function") {
					rdScope = ctx.settingsScope.bind({ namespace: "round-display" });
				}
			} catch {
				rdScope = null;
			}

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

			/** round-display 是否启用（settings 快照解析；不可读时按默认 true）。 */
			function enabledOf(snap) {
				if (snap === null || snap === undefined || snap.status !== "ready") return true;
				const value = snap.value;
				if (value === null || value === undefined || typeof value !== "object") return true;
				return value.enabled !== false;
			}

			/** 取会话 id（从输入区 owner 的 session 快照）。 */
			function sessionIdOf(props) {
				if (props === null || typeof props !== "object") return undefined;
				if (typeof props.session === "object" && props.session !== null && typeof props.session.sessionId === "string") {
					return props.session.sessionId;
				}
				if (typeof props.sessionId === "string") return props.sessionId;
				return undefined;
			}

			/**
			 * 注入面板：当前轮 + 全部轮次。经 RPC 轮询宿主，每次用户消息 = 一轮。
			 */
			function RoundDisplayPanel({ sessionId, onClose }) {
				const [mode, setMode] = useState("current"); // current | history
				const [data, setData] = useState(null);
				const [busy, setBusy] = useState(false);

				const refresh = useCallback(async () => {
					const res = await rpcCall(mode === "current" ? "list" : "history", { sessionId: sessionId || "" });
					if (res !== null) setData(res);
				}, [mode, sessionId]);

				// 打开时拉取 + 打开期间每 2 秒轮询（模型新轮注入也会反映）
				useEffect(() => {
					void refresh();
					const timer = setInterval(() => { void refresh(); }, 2000);
					return () => clearInterval(timer);
				}, [refresh]);

				const turn = data !== null && typeof data.turn === "number" ? data.turn : 0;
				const entries = data !== null && Array.isArray(data.entries) ? data.entries : [];
				const turns = data !== null && Array.isArray(data.turns) ? data.turns : [];

				/** 取条目的来源名；空/缺失时返回空串（显示为「未知来源」）。 */
				function sourceLabelOf(item) {
					return typeof item.plugin === "string" && item.plugin.trim().length > 0 ? item.plugin.trim() : "";
				}

				/** 一条消息渲染成一个独立卡片：左上角紫色来源标签（未知来源用红色兜底）。 */
				function entryBlock(item, key) {
					const plugin = sourceLabelOf(item);
					const known = plugin.length > 0;
					return createElement(
						"div",
						{ className: "rd-entry", key },
						createElement(
							"div",
							{ className: "rd-entry-head" },
							createElement("span", { className: known ? "rd-plugin" : "rd-plugin rd-plugin-unknown" }, known ? "[" + plugin + "]" : "未知来源"),
							typeof item.title === "string" && item.title.length > 0 && createElement("span", { className: "rd-entry-title" }, item.title),
						),
						createElement("pre", { className: "rd-content" }, item.content),
					);
				}

				let currentBody;
				if (entries.length === 0) {
					currentBody = createElement("p", { className: "rd-note" }, "本轮没有插件注入信息。（蹭蹭）");
				} else {
					currentBody = entries.map((item, ii) => entryBlock(item, "cur" + ii));
				}

				let historyBody;
				if (turns.length === 0) {
					historyBody = createElement("p", { className: "rd-note" }, "还没有任何轮次记录。");
				} else {
					historyBody = turns
						.slice()
						.reverse()
						.map((turnEntry, ti) =>
							createElement(
								"div",
								{ className: "rd-group", key: "t" + ti },
								createElement("div", { className: "rd-group-head" },
									createElement("span", { className: "rd-badge" }, "第 " + turnEntry.turn + " 轮"),
									createElement("span", { className: "rd-turn" }, (Array.isArray(turnEntry.entries) ? turnEntry.entries.length : 0) + " 条"),
								),
								(Array.isArray(turnEntry.entries) ? turnEntry.entries : []).map((item, ii) =>
									entryBlock(item, "t" + ti + "-" + ii),
								),
							),
						);
				}

				return createElement(
					"div",
					{ className: "rd-panel", role: "dialog", "aria-label": "本轮插件注入信息面板" },
					createElement(
						"p",
						{ className: "rd-panel-title" },
						"本轮插件注入",
						createElement("span", { className: "rd-badge" }, turn > 0 ? "第 " + turn + " 轮" : "尚未开始"),
						createElement("span", { className: "rd-badge" }, entries.length + " 条"),
						createElement("button", { type: "button", className: "rd-act", disabled: busy, title: "手动刷新", onClick: () => { setBusy(true); void refresh().finally(() => setBusy(false)); } }, "刷新"),
						createElement("button", { type: "button", className: "rd-act", title: "收起", onClick: onClose }, "收起"),
					),
					createElement(
						"p",
						{ className: "rd-note" },
						"Kaz 模式联动/附属插件在本轮（每次用户消息 = 一轮）给模型发送的信息，含 kaz-system-prompt 上报的真实系统提示词（同一轮内系统提示词变化时会保留多个快照，如鲸鱼工作流重构→分类；plan 模式时含 plan:policy 段；goal 工具段启用时含 tool:goal 段）、plan-mode 进入/退出通知、goal-round-driver 的 <goal_round> 与 tool-goal 的 <goal_complete>/<goal_blocked>，以及 round-minimal 上报的首轮工具提示与工具面增删明细。格式：[插件名]>（信息内容）<。",
						lastRpcError.length > 0 && createElement("span", { className: "rd-note" }, "  RPC 通道未就绪：" + lastRpcError),
					),
					createElement(
						"div",
						{ className: "rd-tab" },
						createElement("button", { type: "button", className: "rd-tab-btn", "data-on": mode === "current" ? "true" : "false", onClick: () => setMode("current") }, "当前轮"),
						createElement("button", { type: "button", className: "rd-tab-btn", "data-on": mode === "history" ? "true" : "false", onClick: () => setMode("history") }, "全部轮次"),
					),
					mode === "current" ? currentBody : historyBody,
				);
			}

			/**
			 * 展开按钮：注册在对话输入区右侧（conversation.input.right，会话作用域）。
			 * 按下后在对话框右侧展开本轮 Kaz 插件给模型发送的信息面板。
			 */
			function RoundDisplayButton(props) {
				const [open, setOpen] = useState(false);
				const [closing, setClosing] = useState(false);
				const closeTimer = useRef(null);
				const sessionId = sessionIdOf(props);

				const rootRef = useRef(null);
				const [panelPos, setPanelPos] = useState(null);

				const closePanel = useCallback(() => {
					if (!open) return;
					setClosing(true);
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
					closeTimer.current = setTimeout(() => {
						setOpen(false);
						setClosing(false);
					}, 160);
				}, [open]);

				const openPanel = useCallback(() => {
					if (closeTimer.current !== null) {
						clearTimeout(closeTimer.current);
						closeTimer.current = null;
					}
					setClosing(false);
					setOpen(true);
				}, []);

				useEffect(() => () => {
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				}, []);

				useLayoutEffect(() => {
					if (!open) return;
					const update = () => {
						const el = rootRef.current;
						if (el === null) return;
						const rect = el.getBoundingClientRect();
						const margin = 10;
						const width = Math.min(420, window.innerWidth - 24);
						const maxHeight = Math.min(Math.round(window.innerHeight * 0.7), 600);
						// 面板在按钮右侧展开，右边缘对齐；空间不足时收回窗口内
						let left = rect.right + margin;
						if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - width);
						const below = window.innerHeight - rect.bottom - margin;
						const pos = { left: Math.round(left) + "px", width: Math.round(width) + "px", maxHeight: maxHeight + "px" };
						if (below >= maxHeight || below >= rect.top) pos.top = Math.round(rect.bottom + margin) + "px";
						else pos.bottom = Math.round(window.innerHeight - rect.top + margin) + "px";
						setPanelPos(pos);
					};
					update();
					window.addEventListener("resize", update);
					return () => window.removeEventListener("resize", update);
				}, [open]);

				// 点击面板外的空白区域时平滑收起（与 Kaz 面板、kaz-memory 面板一致）。
				useEffect(() => {
					if (!open) return;
					const onMouseDown = (event) => {
						if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
						if (event.target !== null && event.target !== undefined && typeof event.target.closest === "function" && event.target.closest(".rd-panel") !== null) return;
						closePanel();
					};
					document.addEventListener("mousedown", onMouseDown);
					return () => document.removeEventListener("mousedown", onMouseDown);
				}, [open, closePanel]);

				return createElement(
					"div",
					{ ref: rootRef, className: "rd-root", "data-count": "true" },
					createElement(
						"button",
						{
							type: "button",
							className: "rd-button",
							"data-open": open ? "true" : "false",
							title: open ? "收起本轮插件注入面板" : "查看本轮 Kaz 插件给模型发送的信息",
							onClick: () => {
								if (open) closePanel();
								else openPanel();
							},
						},
						createElement("span", { className: "rd-dot" }),
						createElement("span", { className: "rd-label" }, "本轮注入"),
						createElement("span", { className: "rd-chevron" }, open ? "▲" : "▼"),
					),
					(open || closing) &&
						createPortal(
							createElement(
								"div",
								{
									className: "rd-portal " + (closing ? "rd-closing" : "rd-opening"),
									style: panelPos !== null ? panelPos : undefined,
								},
								createElement(RoundDisplayPanel, { sessionId: sessionId, onClose: closePanel }),
							),
							document.body,
						),
				);
			}

			// ---- 注册 ----
			// 展开按钮：注册进对话输入区工具行右侧（conversation.input.right，会话作用域）。
			// 外面包一层开关门：优先按「与 Kaz 面板同源的当前会话生效值」显示，
			// 取不到（kaz-mode 未加载/无会话）时回退 settings.yaml 开关。
			function useSessionPluginEnabled(pluginId, sessionId) {
				const [enabled, setEnabled] = useState(null);
				useEffect(() => {
					let alive = true;
					let retries = 0;
					let timer = null;
					setEnabled(null);
					const refresh = async () => {
						const state = await kazModeGetState(sessionId);
						if (!alive) return;
						const next = state !== null ? effectiveEnabledOf(state, pluginId) : null;
						setEnabled(next);
						// 新会话刚加载时 agent/项目 cwd 可能尚未就绪，getState 可能短暂返回
						// false；有界重试覆盖该竞态（真实关闭时重试后仍保持 false 并停止）。
						if (next === false && typeof sessionId === "string" && sessionId.length > 0 && retries < 3) {
							const delay = [300, 800, 2000][retries];
							retries += 1;
							timer = setTimeout(() => { void refresh(); }, delay);
						}
					};
					void refresh();
					// 事件驱动：Kaz 面板改动生效状态后广播 kaz-mode:effective-changed，
					// 收到即刷新（替代轮询）。会话切换由 sessionId 依赖触发。
					const onChanged = () => {
						retries = 0;
						if (timer !== null) {
							clearTimeout(timer);
							timer = null;
						}
						void refresh();
					};
					window.addEventListener("kaz-mode:effective-changed", onChanged);
					return () => {
						alive = false;
						if (timer !== null) clearTimeout(timer);
						window.removeEventListener("kaz-mode:effective-changed", onChanged);
					};
				}, [pluginId, sessionId]);
				return enabled;
			}

			function RoundDisplaySlot(props) {
				const snap = useScope(rdScope);
				const settingsEnabled = enabledOf(snap);
				const sessionId = sessionIdOf(props) || useCurrentSessionId();
				const sessionEnabled = useSessionPluginEnabled("round-display", sessionId);
				// 优先用与 Kaz 面板同源的会话状态；取不到（kaz-mode 未加载/无会话）时回退 settings.yaml 开关。
				const enabled = sessionEnabled !== null ? sessionEnabled : settingsEnabled;
				if (enabled !== true) return null;
				return createElement(RoundDisplayButton, props);
			}
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register({ name: "conversation.input.right", id: "round-display", order: 90 }, RoundDisplaySlot),
			);
			// 会话列表订阅：props 拿不到会话时兜底用当前会话（切换会话时重新拉取）。
			// 注：与 kaz-mode / kaz-agent-preset-display 一致，注入 conversation+sessions 两个服务。
			ctx.inject(["conversation", "sessions"], (sessionsScope) => {
				const update = () => {
					const snap = sessionsScope.sessions.list.getSnapshot();
					sessionIdStore.set(snap !== null && snap !== undefined ? snap.current : "");
				};
				update();
				sessionsScope.sessions.list.subscribe(update);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
