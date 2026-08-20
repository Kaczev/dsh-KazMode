window.__ModuleLoader__.load({
	id: "kaz-agent-preset-display",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const createElement = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useRef = react.useRef;
		const useLayoutEffect = react.useLayoutEffect;

		const inject = ["slots", "connection", "settingsScope"];

		function apply(ctx) {
			console.info("[kaz-agent-preset-display] apply");
			// ---- 局部样式 ----
			const css = `
.kapd-root{position:relative;display:inline-flex}
.kapd-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;line-height:1;white-space:nowrap}
.kapd-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kapd-button:disabled{cursor:not-allowed;opacity:.6}
.kapd-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.kapd-chevron{color:var(--dsw-alias-label-tertiary);font-size:10px;flex:none}
.kapd-menu{position:fixed;z-index:1200;min-width:300px;max-height:70vh;overflow:hidden;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 10px 30px rgb(0 0 0 / .2);padding:4px;opacity:0;transform:translateY(-4px);transition:opacity .16s ease,transform .16s ease}
.kapd-menu-scroll{overflow:auto;max-height:inherit;border-radius:10px}
.kapd-menu.kapd-opening{opacity:1;transform:translateY(0)}
.kapd-menu.kapd-closing{opacity:0;transform:translateY(-4px)}
.kapd-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary);padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;line-height:1.4}
.kapd-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kapd-item-main{flex:1;min-width:0;display:flex;flex-direction:column}
.kapd-item-name{font-weight:500}
.kapd-item-desc{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.kapd-item-check{width:20px;height:20px;flex:0 0 20px;color:#fff;margin-left:3px;display:flex;align-items:center;justify-content:center}
.kapd-error{font-size:12px;color:#dc2626;line-height:1.4;max-width:280px}
`;
			const tagId = "kaz-agent-preset-display/styles";
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "kaz-agent-preset-display";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}

			ctx.inject(["slots", "connection", "sessions", "conversation"], (scope) => {
				const api = scope.get("connection").api;
				const sessions = scope.sessions;
				const patchScope =
					ctx.settingsScope !== undefined && ctx.settingsScope !== null && typeof ctx.settingsScope.bind === "function"
						? ctx.settingsScope.bind({ namespace: "kaz-agent-preset-display" })
						: null;

				function currentSession() {
					try {
						const state = sessions.list.getSnapshot();
						const current = state !== null && state !== undefined ? state.current : undefined;
						const summary =
							current !== undefined && state !== null && state.byId !== null && typeof state.byId === "object"
								? state.byId[current]
								: undefined;
						return summary || null;
					} catch {
						return null;
					}
				}

				function sessionIdOf(summary) {
					if (summary === null || summary === undefined) return null;
					if (typeof summary.id === "string" && summary.id.length > 0) return summary.id;
					if (typeof summary.sessionId === "string" && summary.sessionId.length > 0) return summary.sessionId;
					return null;
				}

				function CorrectedAgentPresetSeat() {
					const [options, setOptions] = useState([]);
					const [fallback, setFallback] = useState("");
					const [staged, setStaged] = useState(null);
					const [current, setCurrent] = useState("");
					const [open, setOpen] = useState(false);
					const [closing, setClosing] = useState(false);
					const [busy, setBusy] = useState(false);
					const [error, setError] = useState("");
					const [menuPos, setMenuPos] = useState(null);
					const [layoutTick, setLayoutTick] = useState(0);
					const rootRef = useRef(null);
					const buttonRef = useRef(null);
					const menuRef = useRef(null);
					const closeTimer = useRef(null);
					const stagedRef = useRef(null);
					const loadRef = useRef(null);

					const load = async () => {
						try {
							const response = await api.agentPresets.list({});
							if (response === null || response === undefined || response.result === null || response.result.ok !== true) {
								setError("读取预设列表失败");
								return;
							}
							const presets = Array.isArray(response.result.value?.presets) ? response.result.value.presets : [];
							const defaultId = presets.find((preset) => preset.isDefault === true)?.id ?? presets[0]?.id ?? "";
							const session = currentSession();
							const sessionPreset =
								session !== null && typeof session.agentPreset === "string" ? session.agentPreset : undefined;
							setOptions(presets);
							setFallback(defaultId);
							setError("");
							setLayoutTick((tick) => tick + 1);
							// 关键修正：只要会话自己带了 agentPreset，就优先显示它，
							// 不被 staged / 全局默认带偏。
							setCurrent(sessionPreset || stagedRef.current || defaultId);
							// 如果之前只是“暂存”的选择，现在空白会话出现了，就真正应用它。
							if (
								stagedRef.current !== null &&
								session !== null &&
								session.blank === true &&
								sessionIdOf(session) !== null &&
								session.agentPreset !== stagedRef.current
							) {
								void select(stagedRef.current);
								return;
							}
						} catch (loadError) {
							setError(String((loadError && loadError.message) || loadError));
						}
					};

					loadRef.current = load;

					const closePanel = () => {
						if (!open) return;
						setClosing(true);
						if (closeTimer.current !== null) clearTimeout(closeTimer.current);
						closeTimer.current = setTimeout(() => {
							setOpen(false);
							setClosing(false);
						}, 160);
					};
					const openPanel = () => {
						if (closeTimer.current !== null) {
							clearTimeout(closeTimer.current);
							closeTimer.current = null;
						}
						setClosing(false);
						setOpen(true);
					};
					useEffect(() => () => {
						if (closeTimer.current !== null) clearTimeout(closeTimer.current);
					}, []);

					useEffect(() => {
						void loadRef.current();
					}, []);

					useEffect(() => {
						const stop = sessions.list.subscribe(() => {
							void loadRef.current();
						});
						return stop;
					}, []);

					// 点击外部收起菜单
					useEffect(() => {
						if (!open) return;
						const onMouseDown = (event) => {
							if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
							closePanel();
						};
						document.addEventListener("mousedown", onMouseDown);
						return () => document.removeEventListener("mousedown", onMouseDown);
					}, [open, closePanel]);

					// 菜单固定在视口内：下方空间够就向下展开；
					// 不够时底部贴浏览器下边缘、向上继续拓展，直到上边缘也留出间距。
					useLayoutEffect(() => {
						if (!open) return;
						const update = () => {
							const el = buttonRef.current;
							if (el === null) return;
							const menuEl = menuRef.current;
							const scrollEl = menuEl !== null ? menuEl.firstElementChild : null;
							const rect = el.getBoundingClientRect();
							const width = 320;
							const offset = 10;
							const margin = 6;
							const belowSpace = Math.max(0, window.innerHeight - rect.bottom - offset - margin);
							const aboveSpace = Math.max(0, rect.top - offset - margin);
							const estimatedHeight = Math.max(120, options.length * 72 + 8);
							// 先临时去掉 max-height 再测量真实内容高度，避免第一次打开时
							// 被上一次的小高度限制住，导致测出来偏小。
							let measured = 0;
							if (scrollEl !== null && menuEl !== null) {
								const menuPrevMax = menuEl.style.maxHeight;
								const scrollPrevMax = scrollEl.style.maxHeight;
								menuEl.style.maxHeight = "none";
								scrollEl.style.maxHeight = "none";
								measured = scrollEl.scrollHeight;
								menuEl.style.maxHeight = menuPrevMax;
								scrollEl.style.maxHeight = scrollPrevMax;
							}
							const contentHeight = Math.max(measured, estimatedHeight);
							let maxHeight;
							let top;
							if (contentHeight <= belowSpace) {
								maxHeight = belowSpace;
								top = rect.bottom + offset;
							} else if (contentHeight <= belowSpace + aboveSpace) {
								maxHeight = contentHeight;
								top = Math.max(margin, window.innerHeight - margin - maxHeight);
							} else {
								maxHeight = Math.max(120, window.innerHeight - margin - margin);
								top = margin;
							}
							let left = rect.left;
							if (left + width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - 6 - width);
							setMenuPos({
								left: Math.round(left) + "px",
								top: Math.round(top) + "px",
								width: width + "px",
								maxHeight: maxHeight + "px",
							});
						};
						update();
						window.addEventListener("resize", update);
						return () => window.removeEventListener("resize", update);
					}, [open, options, layoutTick]);

					// 第一次打开时偷偷多刷一次布局：等浏览器完成首帧绘制后再重新测量，
					// 模拟“第二次打开才正确”的效果。
					useEffect(() => {
						if (!open) return;
						const raf = requestAnimationFrame(() => {
							setLayoutTick((tick) => tick + 1);
						});
						return () => cancelAnimationFrame(raf);
					}, [open]);

					const select = async (id) => {
						closePanel();
						const session = currentSession();
						const sessionId = sessionIdOf(session);
						if (session !== null && session.blank === true && sessionId !== null) {
							setBusy(true);
							setError("");
							try {
								const response = await api.agentPresets.select({ sessionId, agentPreset: id });
								if (response !== null && response !== undefined && response.result !== null && response.result.ok === true) {
									const confirmed = response.result.value?.agentPreset ?? id;
									sessions.noteAgentPreset(sessionId, confirmed);
									setCurrent(confirmed);
									setStaged(null);
									stagedRef.current = null;
								} else {
									setError("切换预设失败");
								}
							} catch (selectError) {
								setError(String((selectError && selectError.message) || selectError));
							} finally {
								setBusy(false);
							}
						} else {
							// 还没有可接收的空白会话：先暂存，等会话出现后再应用。
							setStaged(id);
							stagedRef.current = id;
							setCurrent(id);
						}
					};

					const chosen = options.find((option) => option.id === current);
					const label = chosen?.name || chosen?.id || current || "…";

					return createElement(
						"div",
						{ ref: rootRef, className: "kapd-root" },
						createElement(
							"button",
							{
								ref: buttonRef,
								type: "button",
								className: "kapd-button",
								"aria-haspopup": "menu",
								"aria-expanded": open ? "true" : "false",
								disabled: busy,
								title: error || "选择新对话使用的 agent 预设",
								onClick: () => {
									if (open) closePanel();
									else openPanel();
								},
							},
							createElement("span", { className: "kapd-dot" }),
							createElement("span", { className: "kapd-label" }, label),
							createElement("span", { className: "kapd-chevron" }, open ? "▲" : "▼"),
						),
						(open || closing) &&
							createElement(
								"div",
								{ ref: menuRef, className: "kapd-menu " + (closing ? "kapd-closing" : "kapd-opening"), role: "menu", style: menuPos !== null ? menuPos : undefined },
								createElement(
									"div",
									{ className: "kapd-menu-scroll" },
									error.length > 0 && createElement("div", { className: "kapd-error" }, error),
									options.map((option) =>
										createElement(
											"button",
											{
												key: option.id,
												type: "button",
												className: "kapd-item",
												role: "menuitemradio",
												"data-selected": option.id === current ? "true" : "false",
												onClick: () => void select(option.id),
											},
											createElement(
												"span",
												{ className: "kapd-item-main" },
												createElement("span", { className: "kapd-item-name" }, option.name || option.id),
												typeof option.description === "string" && option.description.length > 0
													? createElement("span", { className: "kapd-item-desc" }, option.description)
													: null,
											),
											createElement(
												"span",
												{ className: "kapd-item-check" },
												option.id === current
													? createElement(
														"svg",
														{
															viewBox: "0 0 16 16",
															width: "18",
															height: "18",
															"aria-hidden": "true",
														},
														createElement("path", {
															d: "M2 8.5 L6 12.5 L14 3.5",
															fill: "none",
															stroke: "currentColor",
															strokeWidth: "3",
															strokeLinecap: "round",
															strokeLinejoin: "round",
														}),
													)
													: null,
											),
										),
									),
								),
							),
					);
				}

				let disposeSeat = null;
				const syncEnabled = () => {
					const snap = patchScope !== null ? patchScope.getSnapshot() : null;
					const enabled = snap === null || snap.status !== "ready" ? true : snap.value?.enabled !== false;
					if (enabled && disposeSeat === null) {
						disposeSeat = scope.slots.register(
							{
								name: "conversation.hero.agentPreset",
								id: "kaz-agent-preset-display",
								order: -9999,
								priority: -9999,
							},
							CorrectedAgentPresetSeat,
						);
					} else if (!enabled && disposeSeat !== null) {
						disposeSeat();
						disposeSeat = null;
					}
				};
				syncEnabled();
				const stopPatch = patchScope !== null ? patchScope.subscribe(() => syncEnabled()) : () => {};
				scope.effect(() => () => {
					stopPatch();
					if (disposeSeat !== null) disposeSeat();
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
