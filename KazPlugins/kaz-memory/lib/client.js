window.__ModuleLoader__.load({
	id: "kaz-memory",
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

		/** 宿主注册的专用 RPC 通道（记忆数据不经过 settings.yaml）。 */
		const RPC_CHANNEL = "/kaz-memory";

		const inject = ["slots", "connection", "settingsScope"];

		function statusLabel(status) {
			if (status === "ignored" || status === "suggest") return "已忽略";
			return "已生效";
		}

		/** 取路径的文件夹短名（展示用）。 */
		function baseName(path) {
			if (typeof path !== "string" || path.length === 0) return "";
			const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
			return parts.length > 0 ? parts[parts.length - 1] : path;
		}

		function fmtDate(d) {
			const p = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		/** 时间戳格式化：接受新格式（ISO 字符串）与旧格式（毫秒数字）。 */
		function fmtTime(ts) {
			if (typeof ts === "number" && Number.isFinite(ts)) return fmtDate(new Date(ts));
			if (typeof ts === "string" && ts.length > 0) {
				const d = new Date(ts);
				if (!isNaN(d.getTime())) return fmtDate(d);
			}
			return "";
		}

		function apply(ctx) {
			// ---- 局部样式（随 dsh 主题） ----
			const css = `
.kzm-root{position:relative;display:inline-flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:Inter,var(--dsw-font-family)}
.kzm-button{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:1;white-space:nowrap}
.kzm-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-button:disabled{cursor:not-allowed;opacity:.6}
.kzm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.kzm-root[data-count="true"] .kzm-dot{background:#16a34a}
.kzm-chevron{color:var(--dsw-alias-label-tertiary);font-size:10px;flex:none}
.kzm-panel{position:absolute;top:calc(100% + 10px);right:0;z-index:60;width:480px;max-height:70vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 10px 30px rgb(0 0 0 / .2);padding:10px;display:flex;flex-direction:column;gap:4px;transition:opacity .16s ease,transform .16s ease}
.kzm-portal{position:fixed;z-index:1200}
.kzm-portal .kzm-panel{position:static;top:auto;bottom:auto;left:auto;right:auto;width:100%;box-sizing:border-box}
.kzm-portal.kzm-opening .kzm-panel{opacity:1;transform:translateY(0)}
.kzm-portal.kzm-closing .kzm-panel{opacity:0;transform:translateY(-6px)}
.kzm-bubbles{display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none}
.kzm-bubble-portal{position:fixed;z-index:1300}
.kzm-bubble{position:relative;max-width:340px;padding:8px 12px;border-radius:10px;font-size:12px;line-height:1.4;color:#fff;background:linear-gradient(135deg,#8b5cf6,#6366f1);box-shadow:0 6px 16px rgba(99,102,241,.35);animation:kzm-bubble-in .25s ease-out,kzm-bubble-out .35s ease-in 2.2s forwards}
.kzm-bubble::after{content:"";position:absolute;right:18px;bottom:-6px;border:6px solid transparent;border-top-color:#6366f1;border-bottom:0}
@keyframes kzm-bubble-in{from{opacity:0;transform:translateY(-10px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes kzm-bubble-out{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-6px) scale(.97)}}
.kzm-panel-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kzm-badge{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.kzm-badge[data-count="true"]{color:#16a34a;border-color:rgba(22,163,74,.45)}
.kzm-note{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:2px 0 4px}
.kzm-folder-actions{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 2px}
.kzm-folder-path{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4;word-break:break-all}
.kzm-item{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 2px;display:flex;flex-direction:column;gap:6px}
.kzm-item:first-of-type{border-top:none}
.kzm-item-head{display:flex;align-items:center;gap:8px}
.kzm-item-ns{font-size:11px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:1px 6px;flex:none}
.kzm-item-folder{color:#0ea5e9;border-color:rgba(14,165,233,.45);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kzm-item-when{flex:1;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}
.kzm-item-actions{display:flex;gap:6px;justify-content:flex-end}
.kzm-act{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;cursor:pointer;font-size:12px}
.kzm-act:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-act:disabled{cursor:not-allowed;opacity:.55}
.kzm-act-good{border-color:rgba(22,163,74,.45);color:#16a34a}
.kzm-act-danger{border-color:rgba(220,38,38,.45);color:#dc2626}
.kzm-section-title{display:flex;align-items:center;gap:8px;margin:6px 0 0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kzm-status{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);flex:none}
.kzm-status[data-status="applied"]{color:#16a34a;border-color:rgba(22,163,74,.45)}
.kzm-status[data-status="auto"]{color:#16a34a;border-color:rgba(22,163,74,.45)}
.kzm-autoload-badge{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid rgba(139,92,246,.55);color:#8b5cf6;flex:none;font-weight:600}
.kzm-autoload-toggle{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px}
.kzm-autoload-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kzm-autoload-toggle[data-on="true"]{color:#8b5cf6;border-color:rgba(139,92,246,.55)}
.kzm-summary{font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.5;cursor:pointer}
.kzm-summary:hover{text-decoration:underline}
.kzm-open-text{font-size:12px;color:var(--dsw-alias-label-primary);line-height:1.6;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base))}
.kzm-root[data-compact="true"] .kzm-button{width:28px;padding:0;justify-content:center}
.kzm-root[data-compact="true"] .kzm-label{display:none}
.kzm-root[data-compact="true"] .kzm-chevron{display:none}
`;
			const tagId = "kaz-memory/styles";
			if (typeof document !== "undefined") {
				let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
				if (tag === null) {
					tag = document.createElement("style");
					tag.dataset.plugin = "kaz-memory";
					tag.dataset.pluginCss = tagId;
					document.head.appendChild(tag);
				}
				tag.textContent = css;
			}

			// ---- 专用 RPC 客户端（宿主 /kaz-memory 通道，记忆数据不经过 settings） ----
			// 客户端 connection 服务由 @deepseek-ai/dsh-client-connection 提供（inject 边保证先加载），
			// 它自带 rpc 调用器（ctx.connection.rpc），无需从模块导入（createWebConnectionRpc 未导出）。
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
					console.warn("[kaz-memory] rpc", endpoint, lastRpcError);
					return null;
				} catch (error) {
					lastRpcError = endpoint + ": " + (error !== null && typeof error === "object" && error.message ? error.message : String(error));
					console.warn("[kaz-memory] rpc", endpoint, error);
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

			// ---- settings 绑定：kaz-memory.enabled（standalone 兜底开关，热重载） ----
			let kmScope = null;
			try {
				if (ctx.settingsScope !== undefined && ctx.settingsScope !== null && typeof ctx.settingsScope.bind === "function") {
					kmScope = ctx.settingsScope.bind({ namespace: "kaz-memory" });
				}
			} catch {
				kmScope = null;
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

			/** kaz-memory 是否启用（settings 快照解析；不可读时按默认 true）。 */
			function enabledOf(snap) {
				if (snap === null || snap === undefined || snap.status !== "ready") return true;
				const value = snap.value;
				if (value === null || value === undefined || typeof value !== "object") return true;
				return value.enabled !== false;
			}

			function MemoryPanel({ project }) {
				const [memories, setMemories] = useState([]);
				const [paths, setPaths] = useState(null);
				const [opened, setOpened] = useState(null);
				const [busy, setBusy] = useState(false);
				const [loadErrorMsg, setLoadErrorMsg] = useState("");

				const refresh = useCallback(async () => {
					const res = await rpcCall("list", { project });
					if (res !== null) {
						setMemories(Array.isArray(res.memories) ? res.memories : []);
						setPaths(res.paths !== null && typeof res.paths === "object" ? res.paths : null);
						setLoadErrorMsg("");
					} else {
						setLoadErrorMsg(lastRpcError || "RPC list 失败");
					}
				}, [project]);

				// 打开时拉取 + 打开期间每 2 秒轮询（模型用记忆工具改数据也会反映）；另有手动刷新按钮。
				useEffect(() => {
					refresh();
					const timer = setInterval(() => { void refresh(); }, 2000);
					return () => clearInterval(timer);
				}, [refresh]);

				const run = async (endpoint, id, extra) => {
					setBusy(true);
					try {
						await rpcCall(endpoint, { id: id || "", ...(extra || {}), project });
					} finally {
						setBusy(false);
					}
					await refresh();
				};
				const openItem = async (id) => {
					const res = await rpcCall("open", { id, project });
					if (res !== null) {
						setOpened({ id: String(res.id || id), name: res.name || "", content: res.content || "" });
					}
				};
				const closeOpened = () => setOpened(null);
				const renameItem = async (item) => {
					if (typeof window === "undefined" || !window.prompt) return;
					const next = window.prompt("重命名记忆（保存后写入 JSON）：", item.name || "");
					if (next === null) return;
					await run("rename", item.id, { name: next });
				};

				return createElement(
					"div",
					{ className: "kzm-panel", role: "dialog", "aria-label": "记忆面板" },
					createElement(
						"p",
						{ className: "kzm-panel-title" },
						"记忆面板",
						createElement(
							"button",
							{ type: "button", className: "kzm-act", disabled: busy, title: "手动刷新", onClick: () => void refresh() },
							"刷新",
						),
					),
					createElement(
						"p",
						{ className: "kzm-note" },
						"模型保存的记忆直接生效（applied），无需人工确认；已忽略（ignored）的旧记忆仍保留状态。数据（含名称）全部存在记忆 JSON 文件里；「自动载入」的记忆会在对话开始时自动注入上下文（每会话一次）。",
						loadErrorMsg.length > 0 &&
							createElement(
								"p",
								{ className: "kzm-note" },
								"无法连接记忆服务（RPC 通道未就绪）：" + loadErrorMsg,
							),
					),
					createElement(
						"div",
						{ className: "kzm-folder-actions" },
						createElement(
							"button",
							{ type: "button", className: "kzm-act", disabled: busy || paths === null || !paths.global, title: "在文件管理器中打开全局记忆文件（memory.json）所在文件夹：\n" + (paths !== null ? paths.global : ""), onClick: () => void run("openFolder", "", { target: "global" }) },
							"打开全局记忆文件夹",
						),
						createElement(
							"button",
							{ type: "button", className: "kzm-act", disabled: busy || paths === null || !paths.project, title: "在文件管理器中打开当前项目记忆文件（memory_project.json）所在文件夹：\n" + (paths !== null ? paths.project : ""), onClick: () => void run("openFolder", "", { target: "project" }) },
							"打开项目记忆文件夹",
						),
					),
					paths !== null &&
						createElement(
							"p",
							{ className: "kzm-folder-path" },
							"全局：" + (paths.global || "—") + "\n项目：" + (paths.project || "—"),
						),
					opened !== null &&
						createElement(
							"div",
							{ className: "kzm-item" },
							createElement("span", { className: "kzm-summary" }, opened.name),
							createElement("span", { className: "kzm-open-text" }, opened.content),
							createElement(
								"div",
								{ className: "kzm-item-actions" },
								createElement("button", { type: "button", className: "kzm-act", onClick: closeOpened }, "收起全文"),
							),
						),
					createElement("p", { className: "kzm-section-title" }, "全部记忆（" + memories.length + " 条）"),
					createElement(
						"p",
						{ className: "kzm-note" },
						"只显示当前会话所在项目的记忆（项目记忆存在项目文件夹 .dsh/storages/memory_project.json 里）。点标题查看全文；「自动载入」开关标记哪些记忆会在 memory_search 首次可用时自动注入上下文。",
					),
					memories.length === 0 && createElement("p", { className: "kzm-note" }, "还没有任何记忆。"),
					memories.map((item) =>
						createElement(
							"div",
							{ className: "kzm-item", key: "all-" + item.id },
							createElement(
								"div",
								{ className: "kzm-item-head" },
								createElement("span", { className: "kzm-item-ns" }, item.namespace === "global" ? "全局" : "项目"),
								item.namespace === "project" && item.project
									? createElement("span", { className: "kzm-item-ns kzm-item-folder", title: item.project }, baseName(item.project))
									: null,
								createElement("span", { className: "kzm-status", "data-status": item.status }, statusLabel(item.status)),
								item.autoLoad === true
									? createElement("span", { className: "kzm-autoload-badge" }, "自动载入")
									: null,
								createElement("span", { className: "kzm-item-when" }, fmtTime(item.updated_at)),
							),
							createElement(
								"span",
								{ className: "kzm-summary", title: "查看全文", onClick: () => void openItem(item.id) },
								item.name,
							),
							createElement(
								"div",
								{ className: "kzm-item-actions" },
								createElement(
									"button",
									{
										type: "button",
										className: "kzm-autoload-toggle",
										"data-on": item.autoLoad === true ? "true" : "false",
										disabled: busy,
										title: "标记为自动载入：memory_search 首次可用时自动注入",
										onClick: () => void run("autoLoad", item.id, { autoLoad: item.autoLoad !== true }),
									},
									"自动载入",
								),
								createElement(
									"button",
									{ type: "button", className: "kzm-act", disabled: busy, onClick: () => void renameItem(item) },
									"改名",
								),
								createElement(
									"button",
									{
										type: "button",
										className: "kzm-act kzm-act-danger",
										disabled: busy,
										title: "删除这条记忆（不可恢复）",
										onClick: () => {
											if (typeof window !== "undefined" && window.confirm) {
												if (!window.confirm("确定删除这条记忆？删除后不可恢复。\n\n" + (item.name || ""))) return;
											}
											void run("forget", item.id);
										},
									},
									"删除",
								),
							),
						),
					),
					busy && createElement("p", { className: "kzm-note" }, "处理中…"),
				);
			}

			/**
			 * 记忆按钮：常驻侧边栏底部工具栏（root 作用域——未开始对话时也能
			 * 查看 / 管理记忆），排在 Kaz 按钮左侧（order -2）。点击展开记忆面板；
			 * 收起面板时清空按需正文。
			 * 面板经 portal 挂到 document.body 并用 fixed 定位：侧边栏容器的
			 * overflow 裁剪曾把 absolute 面板挡住（必须拉开侧边栏才能看到）；
			 * 现在面板从按钮右侧展开、按视口边界收拢，任何宽度都不被裁切。
			 *
			 * 项目跟随：root 作用域组件收到 useSessions（全局标准 props），
			 * 其 current = 用户当前选中的会话，SessionSummary.cwd = 该会话的
			 * 工作区路径。这是「用户现在在哪个项目」的权威信号，变化时作为
			 * project 参数随 RPC 传给宿主（不再走 settings 上报）。
			 */
			function MemoryHeaderButton({ wide, useSessions }) {
				const [panelOpen, setPanelOpen] = useState(false);
				const [closing, setClosing] = useState(false);
				const closeTimer = useRef(null);
				const compact = wide === false;
				const [bubbles, setBubbles] = useState([]);
				const [bubblePos, setBubblePos] = useState(null);
				const changeCursor = useRef({ initialized: false, lastSeq: 0 });
				const bubbleTimers = useRef(new Map());

				const showBubbles = useCallback((entries) => {
					if (!Array.isArray(entries) || entries.length === 0) return;
					const additions = entries
						.slice(-3)
						.map((entry) => ({
							key: String(entry.seq) + ":" + String(entry.id),
							text: (entry.operation === "remembered" ? "记忆保存" : "记忆更新") + "「" + (typeof entry.title === "string" ? entry.title : "") + "」",
						}));
					if (additions.length === 0) return;
					setBubbles((prev) => [...prev, ...additions].slice(-3));
					for (const bubble of additions) {
						const timer = setTimeout(() => {
							setBubbles((cur) => cur.filter((item) => item.key !== bubble.key));
							bubbleTimers.current.delete(bubble.key);
						}, 2600);
						bubbleTimers.current.set(bubble.key, timer);
					}
				}, []);

				// 当前会话所在项目（权威信号）：useSessions.current 会话的 cwd。
				let currentCwd = "";
				if (typeof useSessions === "function") {
					try {
						const sessions = useSessions((s) => s);
						if (sessions !== null && sessions !== undefined) {
							const currentId = sessions.current;
							const summary =
								currentId !== undefined && sessions.byId && sessions.byId[currentId] !== undefined
									? sessions.byId[currentId]
									: undefined;
							if (summary !== undefined && typeof summary.cwd === "string") currentCwd = summary.cwd;
						}
					} catch {
						currentCwd = "";
					}
				}

				// 常驻轮询 recentChanges：即使面板收起，也能在「记忆」按钮上方弹气泡。
				useEffect(() => {
					if (!currentCwd) return;
					let alive = true;
					const poll = async () => {
						const changesRes = await rpcCall("recentChanges", { project: currentCwd, after: changeCursor.current.lastSeq });
						if (!alive) return;
						if (changesRes !== null && Array.isArray(changesRes.changes)) {
							const changes = Array.isArray(changesRes.changes) ? changesRes.changes : [];
							if (changeCursor.current.initialized) {
								showBubbles(changes);
							}
							changeCursor.current.initialized = true;
							const nextSeq = Number(changesRes.nextSeq);
							if (Number.isFinite(nextSeq)) changeCursor.current.lastSeq = nextSeq;
						}
					};
					void poll();
					const timer = setInterval(() => { void poll(); }, 2000);
					return () => {
						alive = false;
						clearInterval(timer);
					};
				}, [currentCwd, showBubbles]);

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
					for (const timer of bubbleTimers.current.values()) clearTimeout(timer);
					bubbleTimers.current.clear();
				}, []);

				// 气泡定位：跟随「记忆」按钮上方，用 portal 避免被侧边栏 overflow 裁剪。
				useEffect(() => {
					if (bubbles.length === 0) {
						setBubblePos(null);
						return;
					}
					const update = () => {
						const el = rootRef.current;
						if (el === null) return;
						const rect = el.getBoundingClientRect();
						const width = Math.min(340, window.innerWidth - 24);
						let left = rect.right - width;
						if (left < 12) left = 12;
						setBubblePos({
							left: Math.round(left) + "px",
							bottom: Math.round(window.innerHeight - rect.top + 8) + "px",
							width: Math.round(width) + "px",
						});
					};
					update();
					window.addEventListener("resize", update);
					return () => window.removeEventListener("resize", update);
				}, [bubbles.length > 0]);

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
						let left = rect.right + margin;
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

				const toggle = () => {
					if (panelOpen) closePanel();
					else openPanel();
				};

				return createElement(
					"div",
					{
						ref: rootRef,
						className: "kzm-root",
						"data-side": "true",
						"data-compact": compact ? "true" : "false",
					},
					bubbles.length > 0 && bubblePos !== null &&
						createPortal(
							createElement(
								"div",
								{ className: "kzm-bubbles kzm-bubble-portal", style: bubblePos },
								bubbles.map((bubble) =>
									createElement("div", { key: bubble.key, className: "kzm-bubble" }, bubble.text),
								),
							),
							document.body,
						),
					createElement(
						"button",
						{
							type: "button",
							className: "kzm-button",
							title: "记忆面板",
							onClick: toggle,
						},
						createElement("span", { className: "kzm-dot" }),
						createElement("span", { className: "kzm-label" }, "记忆"),
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
								createElement(MemoryPanel, { project: currentCwd }),
							),
							document.body,
						),
				);
			}

			// ---- 注册 ----
			// 记忆按钮：注册进侧边栏底部工具栏（sidebar.footer.action，root 作用域。
			// 常驻可见——未开始对话时也能查看 / 管理记忆），排在 Kaz 按钮左侧（order -2）。
			// 外面包一层开关门：优先按「与 Kaz 面板同源的当前会话生效值」显示，
			// 取不到（kaz-mode 未加载/无会话）时回退 settings.yaml 开关。
			function useSessionPluginEnabled(pluginId, sessionId) {
				const [enabled, setEnabled] = useState(null);
				useEffect(() => {
					let alive = true;
					setEnabled(null);
					const refresh = async () => {
						const state = await kazModeGetState(sessionId);
						if (!alive) return;
						setEnabled(state !== null ? effectiveEnabledOf(state, pluginId) : null);
					};
					void refresh();
					// 事件驱动：Kaz 面板改动生效状态后广播 kaz-mode:effective-changed，
					// 收到即刷新（替代轮询）。会话切换由 sessionId 依赖触发。
					const onChanged = () => void refresh();
					window.addEventListener("kaz-mode:effective-changed", onChanged);
					return () => {
						alive = false;
						window.removeEventListener("kaz-mode:effective-changed", onChanged);
					};
				}, [pluginId, sessionId]);
				return enabled;
			}

			function MemorySlot(props) {
				const snap = useScope(kmScope);
				const settingsEnabled = enabledOf(snap);
				const sessionId = useCurrentSessionId();
				const sessionEnabled = useSessionPluginEnabled("kaz-memory", sessionId);
				// 优先用与 Kaz 面板同源的会话状态；取不到（kaz-mode 未加载/无会话）时回退 settings.yaml 开关。
				const enabled = sessionEnabled !== null ? sessionEnabled : settingsEnabled;
				if (enabled !== true) return null;
				return createElement(MemoryHeaderButton, props);
			}
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "kaz-memory", order: -2 },
					MemorySlot,
				),
			);
			// 会话列表订阅：把当前会话 id 喂给稳定的 sessionIdStore。
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
