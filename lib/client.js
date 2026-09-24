window.__ModuleLoader__.load({
	id: "dsh-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/**
		* Copy for the viewer, in both shipped languages.
		*
		* Client UI text is locale-owned, so every string the viewer renders comes from
		* here rather than from the component body.
		*/
		/** This plugin's copy namespace. */
		const NS = "dshBrowser";
		/** English dictionary; the key set is the contract. */
		const en = {
			title: "Browser",
			guideTitle: "Browser",
			guideDescription: "Mirror a real local browser, drive it, and attach DevTools to the same port.",
			connecting: "Connecting to the mirror…",
			idle: "The browser is not running yet.",
			starting: "Starting the browser…",
			failed: "The browser could not start.",
			closed: "The browser has stopped.",
			address: "Address",
			secure: "Secure connection (https)",
			insecure: "Not secure (plain http)",
			go: "Go",
			reload: "Reload",
			restart: "Restart browser",
			closeBrowser: "Close browser",
			endpoint: "CDP",
			waiting: "Frames appear here as the page changes.",
			settingsTitle: "Browser",
			settingsIntro: "The local browser this plugin mirrors into the Sidebar and drives for the agent. Every conversation gets its own browser, profile, and CDP port; changing a value here restarts all of them, and the panes reconnect on their own.",
			settingsMode: "Window mode",
			settingsHeadless: "Headless (no window)",
			settingsHeadful: "With a window",
			settingsHeadlessNote: "Headless survives being covered or minimized, but sites that check for automation can tell it apart from a browser you opened yourself.",
			settingsProfile: "Profile",
			settingsProfileTemp: "Temporary (fresh each launch)",
			settingsProfilePersistent: "Persistent directory",
			settingsProfileDir: "Profiles directory",
			settingsProfileDirHint: "Each conversation's browser gets its own subdirectory here, so a sign-in in one conversation is not visible in another. A directory another running browser already holds fails to open.",
			settingsBrowser: "Browser",
			settingsChannelChrome: "Google Chrome",
			settingsChannelEdge: "Microsoft Edge",
			settingsExecutable: "Executable path (overrides the browser choice)",
			settingsPage: "Page size (headless)",
			settingsWidth: "Width",
			settingsHeight: "Height",
			settingsQuality: "Mirror quality (JPEG 1-100)",
			settingsDebugPort: "CDP port",
			settingsUnavailable: "Settings are unavailable in this deployment; the composed configuration is in force.",
			settingsLoading: "Loading settings…",
			settingsReset: "Reset",
			settingsApplied: "The browser restarts with the new value.",
			settingsStealth: "Automation markers",
			settingsStealthOn: "Hidden (recommended)",
			settingsStealthOff: "Left visible",
			settingsStealthNote: "Playwright-started browsers report navigator.webdriver and, headless, spell their user agent HeadlessChrome. Sites that check for automation block those: with the markers left visible Google served its \"unusual traffic\" page three times out of three, and none with them hidden.",
			settingsStatusReading: "Reading the browser state…",
			settingsStatusRunning: "{count} session browser(s) running",
			settingsStatusStarting: "{count} session browser(s) starting",
			settingsStatusNone: "No session browser is running — one starts when a conversation opens it.",
			settingsStatusUnknown: "The browser state could not be read: {error}",
			settingsSessions: "Sessions with a browser",
			settingsSession: "Session",
			settingsInstanceStateRunning: "running",
			settingsInstanceStateStarting: "starting",
			settingsInstanceStateStopped: "stopped",
			settingsInstanceStateFailed: "failed",
			settingsInstancePages: "{count} page(s)",
			settingsRefresh: "Refresh",
			settingsSaved: "Saved. The browser restarts when a launch setting changed.",
			settingsSaveFailed: "Could not save: {error}"
		};
		/** Chinese dictionary. */
		const zh = {
			title: "浏览器",
			guideTitle: "浏览器",
			guideDescription: "镜像本机真实浏览器，可操控，也可用同一端口附加 DevTools。",
			connecting: "正在连接镜像…",
			idle: "浏览器尚未启动。",
			starting: "正在启动浏览器…",
			failed: "浏览器启动失败。",
			closed: "浏览器已停止。",
			address: "地址",
			secure: "安全连接（https）",
			insecure: "不安全（明文 http）",
			go: "前往",
			reload: "刷新",
			restart: "重启浏览器",
			closeBrowser: "关闭浏览器",
			endpoint: "CDP",
			waiting: "页面发生变化时，画面会出现在这里。",
			settingsTitle: "浏览器",
			settingsIntro: "本插件镜像到侧栏、并由 agent 驱动的本机浏览器。每个对话各有一个浏览器、自己的 profile 和 CDP 端口；在此改动会重启全部浏览器，侧栏里的画面会自行重连。",
			settingsMode: "窗口模式",
			settingsHeadless: "无头（无窗口）",
			settingsHeadful: "带窗口",
			settingsHeadlessNote: "无头在窗口被遮挡或最小化时不受影响，但会做自动化检测的站点能把它和你自己打开的浏览器区分开。",
			settingsProfile: "Profile",
			settingsProfileTemp: "临时（每次启动全新）",
			settingsProfilePersistent: "长期目录",
			settingsProfileDir: "Profiles 目录",
			settingsProfileDirHint: "每个对话的浏览器在这里各有自己的子目录，因此一个对话里的登录态不会出现在另一个对话里。若该目录已被另一个运行中的浏览器占用，启动会失败。",
			settingsBrowser: "浏览器",
			settingsChannelChrome: "Google Chrome",
			settingsChannelEdge: "Microsoft Edge",
			settingsExecutable: "可执行文件路径（设置后忽略上面的选择）",
			settingsPage: "页面尺寸（无头）",
			settingsWidth: "宽",
			settingsHeight: "高",
			settingsQuality: "镜像画质（JPEG 1-100）",
			settingsDebugPort: "CDP 端口",
			settingsUnavailable: "当前部署没有设置服务，使用组合配置。",
			settingsLoading: "正在载入设置…",
			settingsReset: "重置",
			settingsApplied: "浏览器会以新值重启。",
			settingsStealth: "自动化标记",
			settingsStealthOn: "隐藏（推荐）",
			settingsStealthOff: "保留",
			settingsStealthNote: "Playwright 启动的浏览器会报告 navigator.webdriver，无头时 UA 还写成 HeadlessChrome。做自动化检测的站点会因此拦截：保留标记时 Google 连续三次搜索全部被拦，隐藏后三次全部通过。",
			settingsStatusReading: "正在读取浏览器状态…",
			settingsStatusRunning: "{count} 个会话浏览器在运行",
			settingsStatusStarting: "{count} 个会话浏览器正在启动",
			settingsStatusNone: "当前没有会话浏览器在运行——某个对话用到时才会启动。",
			settingsStatusUnknown: "读不到浏览器状态：{error}",
			settingsSessions: "有浏览器的会话",
			settingsSession: "会话",
			settingsInstanceStateRunning: "运行中",
			settingsInstanceStateStarting: "启动中",
			settingsInstanceStateStopped: "已停止",
			settingsInstanceStateFailed: "启动失败",
			settingsInstancePages: "{count} 个页面",
			settingsRefresh: "刷新",
			settingsSaved: "已保存。改的是启动项时会重启浏览器。",
			settingsSaveFailed: "保存失败：{error}"
		};
		//#endregion
		//#region src/client/view.tsx
		/**
		* The mirror's viewer: a canvas fed by the plugin's WebSocket, and the few
		* controls that act on the browser behind it.
		*
		* Input leaves as fractions of the frame rather than pixels, so the host never
		* needs to know the viewer's size and resizing the Sidebar cannot shift a
		* click. Printable keys go as text and named keys as key events, mirroring how
		* the host dispatches them.
		*
		* Styles are inline: this plugin builds its client bundle outside the
		* repository's stylesheet pipeline, so a CSS import would have no owner.
		*/
		/** Absolute path the host serves the mirror on. */
		const STREAM_PATH = "/dsh-browser/stream";
		/** Milliseconds between forwarded pointer moves, so a drag does not flood the socket. */
		const MOVE_INTERVAL_MS = 33;
		/** Keys dispatched as key events; anything else printable goes as text. */
		const NAMED_KEYS = [
			"Enter",
			"Tab",
			"Backspace",
			"Delete",
			"Escape",
			"ArrowLeft",
			"ArrowUp",
			"ArrowRight",
			"ArrowDown",
			"Home",
			"End",
			"PageUp",
			"PageDown"
		];
		/** Translate one key, falling back to the bundled dictionary at this dynamic boundary. */
		function copyOf(t) {
			return (key) => t === void 0 ? en[key] : t(key);
		}
		/**
		* Where a pointer event landed, as a fraction of the frame.
		*
		* The canvas fits the frame into its box with `object-fit: contain`, so the
		* drawn image is smaller than the box on one axis and centred in it. Measuring
		* against the box would offset every click wherever the two aspect ratios
		* differ, which is exactly the case for a wide page in a narrow Sidebar.
		* @param element - the canvas the event arrived on.
		* @param clientX - pointer x in viewport coordinates.
		* @param clientY - pointer y in viewport coordinates.
		* @returns the position in `0..1` of the frame, clamped to the frame.
		*/
		function fractionOf(element, clientX, clientY) {
			const rect = element.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0 || element.width === 0 || element.height === 0) return {
				x: 0,
				y: 0
			};
			const scale = Math.min(rect.width / element.width, rect.height / element.height);
			const drawnWidth = element.width * scale;
			const drawnHeight = element.height * scale;
			const x = (clientX - rect.left - (rect.width - drawnWidth) / 2) / drawnWidth;
			const y = (clientY - rect.top - (rect.height - drawnHeight) / 2) / drawnHeight;
			return {
				x: Math.min(1, Math.max(0, x)),
				y: Math.min(1, Math.max(0, y))
			};
		}
		/**
		* Name a DOM button number the way the host's input messages spell it.
		* @param button - the event's button number.
		* @returns the matching button name.
		*/
		function buttonOf(button) {
			if (button === 1) return "middle";
			if (button === 2) return "right";
			return "left";
		}
		/** Height of the address bar, which its pill radius is derived from. */
		const OMNIBOX_HEIGHT = 30;
		/**
		* The design tokens the address bar borrows, so it matches the app in either
		* theme. `--dsw-alias-*` are the theme's own aliases: a layer for the field, a
		* border for its edge, and label colours for the text and the icons.
		*/
		const style = {
			root: {
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				gap: "6px",
				padding: "6px"
			},
			omnibox: {
				boxSizing: "border-box",
				display: "flex",
				alignItems: "center",
				gap: "2px",
				flex: "0 0 auto",
				height: `${String(OMNIBOX_HEIGHT)}px`,
				padding: "0 3px 0 9px",
				borderRadius: `${String(OMNIBOX_HEIGHT / 2)}px`,
				background: "var(--dsw-alias-bg-layer-2, #22262c)",
				border: "1px solid var(--dsw-alias-border-l2, #333b44)"
			},
			omniboxFocused: { borderColor: "var(--dsw-alias-border-l4, #4a5560)" },
			scheme: {
				display: "flex",
				alignItems: "center",
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-tertiary, #93a1b0)"
			},
			schemeInsecure: { color: "var(--dsw-alias-state-warn-label, #d19a66)" },
			address: {
				flex: "1 1 auto",
				minWidth: 0,
				height: "100%",
				padding: "0 4px",
				border: "none",
				outline: "none",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, inherit)",
				font: "inherit",
				fontSize: "12px"
			},
			iconButton: {
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				flex: "0 0 auto",
				width: `${String(24)}px`,
				height: `${String(24)}px`,
				padding: 0,
				border: "none",
				borderRadius: "50%",
				cursor: "pointer",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, #93a1b0)"
			},
			iconButtonHovered: {
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))",
				color: "var(--dsw-alias-label-primary, #fff)"
			},
			stage: {
				position: "relative",
				flex: "1 1 auto",
				minHeight: 0,
				overflow: "hidden",
				background: "#101418"
			},
			canvas: {
				display: "block",
				width: "100%",
				height: "100%",
				objectFit: "contain",
				outline: "none"
			},
			note: {
				position: "absolute",
				inset: 0,
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				alignItems: "center",
				justifyContent: "center",
				textAlign: "center",
				padding: "12px",
				fontSize: "12px",
				color: "#93a1b0",
				pointerEvents: "none"
			},
			noteCard: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				alignItems: "center",
				maxWidth: "90%",
				padding: "10px 14px",
				borderRadius: "8px",
				background: "rgba(16, 20, 24, 0.88)",
				color: "#d7dee6",
				lineHeight: 1.5
			},
			noteButton: {
				padding: "4px 8px",
				fontSize: "12px",
				cursor: "pointer",
				pointerEvents: "auto",
				background: "var(--dsh-button-background, #2b6cb0)",
				color: "#fff",
				border: "none",
				borderRadius: "4px"
			},
			status: {
				flex: "0 0 auto",
				display: "flex",
				gap: "6px",
				alignItems: "center",
				fontSize: "11px",
				color: "#93a1b0"
			},
			statusText: {
				flex: "1 1 auto",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			statusButton: {
				flex: "0 0 auto",
				padding: "2px 8px",
				fontSize: "11px",
				cursor: "pointer",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2, #333b44)",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, inherit)"
			}
		};
		/** The lock a secure address shows, drawn at the size the bar's icons share. */
		const LOCK_ICON = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
			x: "3.5",
			y: "7",
			width: "9",
			height: "6.5",
			rx: "2"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" })] });
		/** The globe an insecure or empty address shows. */
		const GLOBE_ICON = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
			cx: "8",
			cy: "8",
			r: "5.25"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.75 8h10.5M8 2.75c1.5 1.5 2.25 3.25 2.25 5.25S9.5 14.5 8 13.25C6.5 11.75 5.75 10 5.75 8S6.5 4.25 8 2.75Z" })] });
		/** The circular arrow a page that needs no navigation shows. */
		const RELOAD_ICON = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.75 8a4.75 4.75 0 1 1-1.4-3.36" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.9 2.6v3.1h-3.1" })] });
		/** The arrow an edited address shows, which submits it. */
		const GO_ICON = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3 8h9.5" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 4.5 12.5 8 9 11.5" })] });
		/**
		* One icon control inside the address bar.
		*
		* Hover is tracked in state rather than by a stylesheet: this plugin's client
		* bundle has no stylesheet of its own, so every appearance here is an inline
		* style, and a pseudo-class is not one.
		* @param props - the icon, its accessible name, and what it does.
		* @returns the button.
		*/
		function IconButton(props) {
			const [hovered, setHovered] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: props.submit === true ? "submit" : "button",
				"aria-label": props.label,
				title: props.label,
				onClick: props.onClick,
				onMouseEnter: () => {
					setHovered(true);
				},
				onMouseLeave: () => {
					setHovered(false);
				},
				style: {
					...style.iconButton,
					...hovered ? style.iconButtonHovered : {}
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "14",
					height: "14",
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.4",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					children: props.icon
				})
			});
		}
		/**
		* The mirror's body: canvas, address bar, and the browser's own status.
		* @param props - composed slot props.
		* @returns the viewer.
		*/
		function BrowserBody({ sessionId, t }) {
			const copy = copyOf(t);
			const canvasRef = (0, react.useRef)(null);
			const socketRef = (0, react.useRef)(void 0);
			const lastMoveRef = (0, react.useRef)(0);
			const [address, setAddress] = (0, react.useState)("");
			const [status, setStatus] = (0, react.useState)(void 0);
			const [connected, setConnected] = (0, react.useState)(false);
			const [painted, setPainted] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [focused, setFocused] = (0, react.useState)(false);
			/**
			* Draw one received frame.
			* @param buffer - the JPEG bytes of the frame.
			*/
			const drawFrame = (0, react.useCallback)(async (buffer) => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" }));
				if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
				if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
				canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
				bitmap.close();
				setPainted(true);
			}, []);
			(0, react.useEffect)(() => {
				const scheme = location.protocol === "https:" ? "wss:" : "ws:";
				const query = new URLSearchParams({ session: sessionId });
				const socket = new WebSocket(`${scheme}//${location.host}${STREAM_PATH}?${query.toString()}`);
				socket.binaryType = "arraybuffer";
				socket.onopen = () => {
					setConnected(true);
				};
				socket.onclose = () => {
					setConnected(false);
				};
				socket.onerror = () => {
					setConnected(false);
				};
				socket.onmessage = (event) => {
					if (typeof event.data !== "string") {
						drawFrame(event.data);
						return;
					}
					const parsed = JSON.parse(event.data);
					if (parsed.type === "status" && parsed.status !== void 0) {
						setStatus(parsed.status);
						setFailure(void 0);
						return;
					}
					if (parsed.type === "error") setFailure(String(parsed.message));
				};
				socketRef.current = socket;
				return () => {
					socketRef.current = void 0;
					socket.close();
				};
			}, [drawFrame, sessionId]);
			const browserUrl = status?.url;
			(0, react.useEffect)(() => {
				if (browserUrl !== void 0 && browserUrl !== "" && browserUrl !== "about:blank") setAddress(browserUrl);
			}, [browserUrl]);
			/**
			* Send one viewer message.
			* @param payload - the message to encode.
			*/
			const send = (0, react.useCallback)((payload) => {
				const socket = socketRef.current;
				if (socket !== void 0 && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
			}, []);
			/**
			* Send one input message.
			* @param message - the host's input message.
			*/
			const sendInput = (0, react.useCallback)((message) => {
				send({
					type: "input",
					message
				});
			}, [send]);
			/**
			* Navigate to what the address bar holds.
			*
			* Both Enter and the arrow button land here, because an implicit form
			* submission is not the only way this pane is asked to navigate and the two
			* must not drift apart.
			*/
			const submit = (0, react.useCallback)(() => {
				const target = address.trim();
				if (target !== "") send({
					type: "navigate",
					url: target
				});
			}, [address, send]);
			const state = status?.state;
			const shownUrl = status?.url ?? "";
			/** Whether the address bar holds something the browser is not on. */
			const dirty = address.trim() !== "" && address !== shownUrl;
			const secure = shownUrl.startsWith("https://");
			const note = failure !== void 0 ? failure : !connected ? copy("connecting") : painted && state !== "failed" && state !== "closed" ? void 0 : state === "failed" ? `${copy("failed")} ${status?.error ?? ""}`.trim() : state === "starting" ? copy("starting") : state === "ready" ? copy("waiting") : state === "closed" ? `${copy("closed")} ${status?.error ?? ""}`.trim() : copy("idle");
			const recoverable = failure !== void 0 || state === "failed" || state === "closed";
			const live = state === "ready" || state === "starting";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: style.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						style: {
							...style.omnibox,
							...focused ? style.omniboxFocused : {}
						},
						onSubmit: (event) => {
							event.preventDefault();
							submit();
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...style.scheme,
									...secure ? {} : style.schemeInsecure
								},
								title: secure ? copy("secure") : copy("insecure"),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									width: "14",
									height: "14",
									viewBox: "0 0 16 16",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "1.3",
									strokeLinecap: "round",
									strokeLinejoin: "round",
									"aria-hidden": "true",
									children: secure ? LOCK_ICON : GLOBE_ICON
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: style.address,
								value: address,
								placeholder: copy("address"),
								spellCheck: false,
								autoComplete: "off",
								"aria-label": copy("address"),
								onFocus: (event) => {
									setFocused(true);
									event.currentTarget.select();
								},
								onBlur: () => {
									setFocused(false);
								},
								onChange: (event) => {
									setAddress(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submit();
									}
								}
							}),
							dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconButton, {
								label: copy("go"),
								icon: GO_ICON,
								onClick: submit,
								submit: true
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconButton, {
								label: copy("reload"),
								icon: RELOAD_ICON,
								onClick: () => {
									send({ type: "reload" });
								}
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style.stage,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
							ref: canvasRef,
							tabIndex: 0,
							style: style.canvas,
							onContextMenu: (event) => {
								event.preventDefault();
							},
							onMouseDown: (event) => {
								const at = fractionOf(event.currentTarget, event.clientX, event.clientY);
								sendInput({
									type: "mouse",
									action: "down",
									x: at.x,
									y: at.y,
									button: buttonOf(event.button),
									clickCount: 1
								});
							},
							onMouseUp: (event) => {
								const at = fractionOf(event.currentTarget, event.clientX, event.clientY);
								sendInput({
									type: "mouse",
									action: "up",
									x: at.x,
									y: at.y,
									button: buttonOf(event.button),
									clickCount: 1
								});
							},
							onMouseMove: (event) => {
								const now = Date.now();
								if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return;
								lastMoveRef.current = now;
								const at = fractionOf(event.currentTarget, event.clientX, event.clientY);
								sendInput({
									type: "mouse",
									action: "move",
									x: at.x,
									y: at.y
								});
							},
							onWheel: (event) => {
								const at = fractionOf(event.currentTarget, event.clientX, event.clientY);
								sendInput({
									type: "wheel",
									x: at.x,
									y: at.y,
									deltaX: event.deltaX,
									deltaY: event.deltaY
								});
							},
							onKeyDown: (event) => {
								if (event.key.length === 1) {
									sendInput({
										type: "text",
										text: event.key
									});
									event.preventDefault();
									return;
								}
								if (NAMED_KEYS.includes(event.key)) {
									sendInput({
										type: "key",
										key: event.key
									});
									event.preventDefault();
								}
							}
						}), note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: style.note,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: style.noteCard,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: note }), recoverable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: style.noteButton,
									onClick: () => {
										send({ type: "restart" });
									},
									children: copy("restart")
								}) : null]
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: style.status,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: style.statusText,
							children: status?.debugPort === void 0 ? "" : `${copy("endpoint")} 127.0.0.1:${status.debugPort}`
						}), live ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: style.statusButton,
							onClick: () => {
								send({ type: "close" });
							},
							children: copy("closeBrowser")
						}) : null]
					})
				]
			});
		}
		//#endregion
		//#region src/client/api.ts
		/**
		* Read the live browser state.
		* @returns every session's browser, as the host sees it.
		* @throws {Error} when the route refuses or the answer is not a report.
		*/
		async function browserStatus() {
			const response = await fetch("/dsh-browser/status", { headers: { Accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}
		//#endregion
		//#region src/client/settings.tsx
		/**
		* The 浏览器 settings section.
		*
		* Values arrive from the plugin's settings namespace — the composition entry
		* with the user's overrides resolved over it — and every control writes one
		* field back through the bound scope, so the page never holds a draft that can
		* disagree with what the browser was launched from.
		*
		* The profile mode is the one exception: an empty directory is what selects a
		* fresh temporary profile, so "persistent" has nothing to store until the user
		* names a directory. That choice is local until a path exists, because
		* inventing one would silently create a profile somewhere the user did not ask
		* for.
		*
		* Styles are inline: this plugin builds its client bundle outside the
		* repository's stylesheet pipeline, so a CSS import would have no owner.
		*/
		const styles = {
			page: {
				display: "flex",
				flexDirection: "column",
				gap: "14px",
				maxWidth: "720px"
			},
			intro: {
				margin: 0,
				fontSize: "12px",
				lineHeight: 1.6,
				opacity: .75
			},
			group: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				borderTop: "1px solid rgba(128,128,128,0.25)",
				paddingTop: "12px"
			},
			row: {
				display: "flex",
				gap: "12px",
				alignItems: "flex-start",
				justifyContent: "space-between"
			},
			label: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				flex: "1 1 auto",
				minWidth: 0
			},
			name: { fontSize: "13px" },
			hint: {
				fontSize: "11px",
				opacity: .6,
				lineHeight: 1.5
			},
			control: {
				display: "flex",
				gap: "6px",
				alignItems: "center",
				flex: "0 0 auto"
			},
			input: {
				padding: "4px 6px",
				fontSize: "12px",
				width: "240px",
				borderRadius: "4px",
				border: "1px solid var(--dsh-border, #333b44)",
				background: "var(--dsh-input-background, #1b1f24)",
				color: "inherit"
			},
			number: {
				padding: "4px 6px",
				fontSize: "12px",
				width: "84px",
				borderRadius: "4px",
				border: "1px solid var(--dsh-border, #333b44)",
				background: "var(--dsh-input-background, #1b1f24)",
				color: "inherit"
			},
			select: {
				padding: "4px 6px",
				fontSize: "12px",
				borderRadius: "4px",
				border: "1px solid var(--dsh-border, #333b44)",
				background: "var(--dsh-input-background, #1b1f24)",
				color: "inherit"
			},
			reset: {
				padding: "3px 8px",
				fontSize: "11px",
				cursor: "pointer",
				borderRadius: "4px",
				border: "1px solid var(--dsh-border, #333b44)",
				background: "transparent",
				color: "inherit",
				opacity: .8
			},
			note: {
				margin: 0,
				fontSize: "11px",
				opacity: .6
			},
			status: {
				display: "flex",
				gap: "10px",
				alignItems: "center",
				justifyContent: "space-between",
				padding: "8px 10px",
				borderRadius: "6px",
				fontSize: "12px",
				border: "1px solid rgba(128,128,128,0.3)",
				background: "rgba(128,128,128,0.08)"
			},
			statusText: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				minWidth: 0
			},
			statusDetail: {
				fontSize: "11px",
				opacity: .65,
				wordBreak: "break-all"
			},
			statusFailed: { color: "var(--dsh-danger, #e06c75)" },
			save: {
				margin: 0,
				fontSize: "11px",
				opacity: .75,
				minHeight: "15px"
			},
			saveFailed: {
				margin: 0,
				fontSize: "11px",
				color: "var(--dsh-danger, #e06c75)",
				minHeight: "15px"
			}
		};
		/** One labelled control, with a reset affordance once the user layer holds the field. */
		function Row(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.label,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.name,
						children: props.label
					}), props.hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.hint,
						children: props.hint
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.control,
					children: [props.children, props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: styles.reset,
						onClick: props.onReset,
						children: props.resetLabel
					}) : null]
				})]
			});
		}
		/**
		* What the banner says about the browsers right now.
		*
		* The state is the host's, not the form's: it is the only way a user can tell a
		* saved value from a value a browser is actually running with.
		* @param report - the last read, or `undefined` before the first answer.
		* @param t - copy for this namespace.
		* @returns the banner's summary line.
		*/
		function statusLine(report, t) {
			if (report === void 0) return t("settingsStatusReading");
			const running = report.instances.filter((instance) => instance.state === "ready").length;
			const starting = report.instances.filter((instance) => instance.state === "starting").length;
			if (running > 0) return t("settingsStatusRunning").replace("{count}", String(running));
			if (starting > 0) return t("settingsStatusStarting").replace("{count}", String(starting));
			return t("settingsStatusNone");
		}
		/**
		* One session's browser as a single line: which session, what state, and the
		* facts only a running one has.
		* @param instance - one entry of the report.
		* @param t - copy for this namespace.
		* @returns the line to show for it.
		*/
		function instanceLine(instance, t) {
			const state = instance.state === "ready" ? t("settingsInstanceStateRunning") : instance.state === "starting" ? t("settingsInstanceStateStarting") : instance.state === "failed" ? `${t("settingsInstanceStateFailed")} — ${instance.error ?? ""}`.trim() : t("settingsInstanceStateStopped");
			const label = instance.sessionId.replace(/^session-/, "").slice(0, 8);
			const parts = [`${t("settingsSession")} ${label}`, state];
			if (instance.debugPort !== void 0) parts.push(`CDP 127.0.0.1:${instance.debugPort}`);
			if (instance.mode !== void 0) parts.push(instance.mode);
			const pages = instance.tabs?.length ?? 0;
			if (pages > 0) parts.push(t("settingsInstancePages").replace("{count}", String(pages)));
			return parts.join(" · ");
		}
		/**
		* The 浏览器 settings page.
		* @param props - section owner props plus the bound namespace scope.
		* @returns the section element.
		*/
		function BrowserSettingsSection(props) {
			const { form, t } = props;
			const subscribe = (0, react.useCallback)((listener) => form.subscribe(listener), [form]);
			const snapshot = (0, react.useSyncExternalStore)(subscribe, () => form.getSnapshot());
			const [persistentChoice, setPersistentChoice] = (0, react.useState)(void 0);
			const [status, setStatus] = (0, react.useState)(void 0);
			const [statusError, setStatusError] = (0, react.useState)(void 0);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const timers = (0, react.useRef)([]);
			/** Read the host's live state; the page cannot see the browser any other way. */
			const refresh = (0, react.useCallback)(() => {
				browserStatus().then((next) => {
					setStatus(next);
					setStatusError(void 0);
				}).catch((error) => {
					setStatusError(error instanceof Error ? error.message : String(error));
				});
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				const pending = timers.current;
				return () => {
					for (const id of pending) window.clearTimeout(id);
					pending.length = 0;
				};
			}, [refresh]);
			/**
			* Report one settings write, then re-read the browser it may have restarted.
			* A launch field closes the running browser and the next frame request starts
			* a new one, so the later reads are what catch the restarted instance rather
			* than the one that is on its way out. Resetting a field is a write like any
			* other and goes through here too — otherwise the banner keeps reporting the
			* browser the user just replaced.
			* @param operation - the form write to track.
			*/
			const commit = (operation) => {
				setSaved(false);
				setSaveError(void 0);
				operation.then(() => {
					setSaved(true);
					for (const delay of [
						1500,
						4e3,
						8e3
					]) timers.current.push(window.setTimeout(refresh, delay));
				}).catch((error) => {
					setSaveError(error instanceof Error ? error.message : String(error));
				});
			};
			/**
			* Write one field and report both the write and the browser it may restart.
			* @param field - the configuration field.
			* @param next - its new value.
			*/
			const write = (field, next) => {
				commit(form.set(field, next));
			};
			if (snapshot.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.intro,
				children: t("settingsLoading")
			});
			const value = snapshot.value;
			if (value === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles.intro,
				children: t("settingsUnavailable")
			});
			const user = typeof snapshot.user === "object" && snapshot.user !== null ? snapshot.user : {};
			const persistent = persistentChoice ?? value.userDataDir !== "";
			/** A field the user layer holds, so clearing it restores the composed value. */
			const owns = (field) => Object.hasOwn(user, field);
			/** A field is overridden once the user layer holds it. */
			const row = (label, field, control, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				label,
				hint,
				overridden: owns(field),
				resetLabel: t("settingsReset"),
				onReset: () => {
					if (field === "userDataDir") setPersistentChoice(void 0);
					commit(form.unset(field));
				},
				children: control
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.intro,
						children: t("settingsIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.status,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.statusText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: statusError !== void 0 ? styles.statusFailed : void 0,
								children: statusError !== void 0 ? t("settingsStatusUnknown").replace("{error}", statusError) : statusLine(status, t)
							}), (status?.instances.length ?? 0) === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.statusDetail,
								children: t("settingsSessions")
							}), status?.instances.map((instance) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.statusDetail,
								children: instanceLine(instance, t)
							}, instance.sessionId))] })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.reset,
							onClick: refresh,
							children: t("settingsRefresh")
						})]
					}),
					saveError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.saveFailed,
						children: t("settingsSaveFailed").replace("{error}", saveError)
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.save,
						children: saved ? t("settingsSaved") : ""
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [
							row(t("settingsMode"), "headless", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.select,
								value: value.headless ? "headless" : "headful",
								onChange: (event) => {
									write("headless", event.target.value === "headless");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "headless",
									children: t("settingsHeadless")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "headful",
									children: t("settingsHeadful")
								})]
							}), t("settingsHeadlessNote")),
							row(t("settingsStealth"), "stealth", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.select,
								value: value.stealth ? "on" : "off",
								onChange: (event) => {
									write("stealth", event.target.value === "on");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "on",
									children: t("settingsStealthOn")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "off",
									children: t("settingsStealthOff")
								})]
							}), t("settingsStealthNote")),
							row(t("settingsProfile"), "userDataDir", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.select,
								value: persistent ? "persistent" : "temp",
								onChange: (event) => {
									const next = event.target.value === "persistent";
									setPersistentChoice(next);
									if (!next) write("userDataDir", "");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "temp",
									children: t("settingsProfileTemp")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "persistent",
									children: t("settingsProfilePersistent")
								})]
							}), t("settingsProfileDirHint")),
							persistent ? row(t("settingsProfileDir"), "userDataDir", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: value.userDataDir,
								spellCheck: false,
								placeholder: "D:\\\\chrome-profile",
								onChange: (event) => {
									setPersistentChoice(true);
									write("userDataDir", event.target.value);
								}
							})) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [
							row(t("settingsBrowser"), "channel", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.select,
								value: value.channel,
								onChange: (event) => {
									write("channel", event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "chrome",
									children: t("settingsChannelChrome")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "msedge",
									children: t("settingsChannelEdge")
								})]
							})),
							row(t("settingsExecutable"), "executablePath", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: value.executablePath,
								spellCheck: false,
								onChange: (event) => {
									write("executablePath", event.target.value);
								}
							})),
							row(t("settingsDebugPort"), "debugPort", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.number,
								type: "number",
								min: 1,
								max: 65535,
								value: value.debugPort,
								onChange: (event) => {
									write("debugPort", Number(event.target.value));
								}
							}))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.group,
						children: [row(t("settingsPage"), "viewportWidth", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.number,
							type: "number",
							min: 320,
							max: 3840,
							value: value.viewportWidth,
							onChange: (event) => {
								write("viewportWidth", Number(event.target.value));
							},
							"aria-label": t("settingsWidth")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.number,
							type: "number",
							min: 240,
							max: 2160,
							value: value.viewportHeight,
							onChange: (event) => {
								write("viewportHeight", Number(event.target.value));
							},
							"aria-label": t("settingsHeight")
						})] })), row(t("settingsQuality"), "quality", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.number,
							type: "number",
							min: 1,
							max: 100,
							value: value.quality,
							onChange: (event) => {
								write("quality", Number(event.target.value));
							}
						}))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.note,
						children: t("settingsApplied")
					})
				]
			});
		}
		//#endregion
		//#region src/client/definition.ts
		/** The tab kind this plugin owns. */
		const BROWSER_KIND = "cdpBrowser";
		/** This implementation's identity: the key its body and title register under. */
		const BROWSER_ID = "dsh-browser";
		/**
		* The mirror's registry definition.
		* @param title - the tab chip's text in the current language.
		* @param guideTitle - the guide entry's title in the current language.
		* @param guideDescription - the guide entry's one-line description.
		* @returns the definition to register.
		*/
		function browserDefinition(title, guideTitle, guideDescription) {
			return {
				id: BROWSER_ID,
				kind: BROWSER_KIND,
				priority: "extension",
				title,
				guide: [{
					id: BROWSER_ID,
					order: 40,
					title: guideTitle,
					description: guideDescription
				}]
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Required browser services: the tab registry, the slot registry, and copy. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs"
		];
		/** The settings namespace the host half registers, and this page edits. */
		const SETTINGS_NAMESPACE = "dsh-browser";
		/**
		* Client plugin body: register the dictionaries, the tab type, its body, and
		* the settings page.
		* @param ctx - client root context carrying the registries and copy.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-browser: dictionaries");
			ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(() => t("title"), () => t("guideTitle"), () => t("guideDescription"))), "dsh-browser: cdpBrowser type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: BROWSER_ID,
				locale: NS,
				inject: (sessionId) => ({ sessionId })
			}, BrowserBody)), "dsh-browser: viewer body");
			ctx.inject(["configForms"], (settingsCtx) => {
				const form = settingsCtx.configForms.get(SETTINGS_NAMESPACE);
				settingsCtx.effect(() => settingsCtx.configForms.whileServed([SETTINGS_NAMESPACE], () => settingsCtx.slots.inject("settings.section", () => settingsCtx.slots.register({
					name: "settings.section",
					id: BROWSER_ID,
					order: 46,
					label: () => t("settingsTitle"),
					inject: () => ({
						form,
						t
					})
				}, BrowserSettingsSection))), "dsh-browser: settings section");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map