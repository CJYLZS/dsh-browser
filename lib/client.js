window.__ModuleLoader__.load({
	id: "dsh-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/clipboard.ts
		/**
		* Whether this keystroke is one of the clipboard shortcuts the pane owns.
		*
		* Alt disqualifies it: on Windows AltGr arrives as Control+Alt and still types a
		* character, and the pane's own key path sends that as text. Shift does not:
		* `Control+Shift+V` is a browser's paste-as-plain-text, which is exactly what the
		* mirror's paste is, and nothing here claims Shift+C or Shift+X.
		* @param event - the keydown to classify.
		* @returns the chord to handle, or undefined when the key belongs to the mirror.
		*/
		function clipboardChord(event) {
			if (event.altKey) return void 0;
			if (!event.ctrlKey && !event.metaKey) return void 0;
			switch (event.key.toLowerCase()) {
				case "c": return "copy";
				case "x": return "cut";
				case "v": return "paste";
				default: return;
			}
		}
		/**
		* What a copy or a cut does with the text the mirror reported.
		*
		* An empty selection writes nothing: a browser's own copy with nothing selected
		* leaves the clipboard as it was, and overwriting it with "" would be the pane
		* clobbering a clipboard the user did not ask it to touch. A cut that did have
		* something deletes it in the mirror, which is the whole difference between the
		* two chords.
		* @param chord - the reading chord that was pressed.
		* @param text - the selection the mirror reported.
		* @returns the clipboard write and, for a cut, the delete that follows it.
		*/
		function clipboardReply(chord, text) {
			if (text === "") return {
				write: void 0,
				after: void 0
			};
			return {
				write: text,
				...chord === "cut" ? { after: {
					type: "key",
					key: "Delete"
				} } : { after: void 0 }
			};
		}
		/**
		* What a paste sends the mirror, if anything.
		*
		* An empty clipboard sends nothing: `Input.insertText` with "" would be a
		* keystroke the page never saw, and there is nothing to insert anyway.
		* @param text - the clipboard text the pane read.
		* @returns the text input message, or undefined when there is nothing to paste.
		*/
		function pasteMessage(text) {
			return text === "" ? void 0 : {
				type: "text",
				text
			};
		}
		//#endregion
		//#region src/browser/keys.ts
		/** Keys worth dispatching as key events; anything else printable goes through `insertText`. */
		const NAMED_KEYS = {
			Enter: {
				code: "Enter",
				keyCode: 13,
				text: "\r"
			},
			Tab: {
				code: "Tab",
				keyCode: 9
			},
			Backspace: {
				code: "Backspace",
				keyCode: 8
			},
			Delete: {
				code: "Delete",
				keyCode: 46
			},
			Escape: {
				code: "Escape",
				keyCode: 27
			},
			ArrowLeft: {
				code: "ArrowLeft",
				keyCode: 37
			},
			ArrowUp: {
				code: "ArrowUp",
				keyCode: 38
			},
			ArrowRight: {
				code: "ArrowRight",
				keyCode: 39
			},
			ArrowDown: {
				code: "ArrowDown",
				keyCode: 40
			},
			Home: {
				code: "Home",
				keyCode: 36
			},
			End: {
				code: "End",
				keyCode: 35
			},
			PageUp: {
				code: "PageUp",
				keyCode: 33
			},
			PageDown: {
				code: "PageDown",
				keyCode: 34
			}
		};
		/**
		* The modifiers a chord may name, as the bit field CDP takes.
		*
		* The aliases are the ones a keyboard and the platform APIs give the same four
		* keys, so a chord written either way presses the same thing.
		*/
		const MODIFIERS = {
			Alt: 1,
			Option: 1,
			Control: 2,
			Ctrl: 2,
			Meta: 4,
			Command: 4,
			Cmd: 4,
			Shift: 8
		};
		/** How to spell the modifiers in a message about them. */
		const MODIFIER_NAMES = "Control, Meta, Alt, Shift";
		/** Shift, as the bit field spells it. */
		const SHIFT = 8;
		/** Modifiers that stop the key from producing text, as a browser does. */
		const SUPPRESSES_TEXT = 7;
		/**
		* One character pressed as a key.
		*
		* Only a letter's case follows Shift, because only a letter's case is the same
		* on every keyboard: `Shift+1` is `!` on a US layout and something else on the
		* next one, so a character that is not a letter is pressed as it is written and
		* typing it as text is the caller's job.
		* @param token - the character the chord named.
		* @param modifiers - the modifiers held.
		* @returns the resolved press.
		*/
		function characterStroke(token, modifiers) {
			const letter = /^[a-z]$/iu.test(token);
			const digit = /^[0-9]$/u.test(token);
			const upper = token.toUpperCase();
			const key = letter ? (modifiers & SHIFT) === 0 ? token.toLowerCase() : upper : token;
			return {
				key,
				code: letter ? `Key${upper}` : digit ? `Digit${token}` : token === " " ? "Space" : void 0,
				keyCode: letter ? upper.charCodeAt(0) : digit ? 48 + Number(token) : token === " " ? 32 : void 0,
				text: (modifiers & SUPPRESSES_TEXT) === 0 ? key : void 0,
				modifiers
			};
		}
		/**
		* Resolve one chord into the press it describes.
		*
		* @param chord - a key name, a single character, or modifiers joined to either
		* with `+`.
		* @returns what to dispatch.
		* @throws {Error} when the chord names no key, an unknown modifier, or a key
		* that has no dispatch mapping.
		*/
		function parseKeyStroke(chord) {
			const tokens = chord.split("+");
			const named = tokens.slice(0, -1);
			const last = tokens.at(-1) ?? "";
			let modifiers = 0;
			for (const token of named) {
				const bit = MODIFIERS[token];
				if (bit === void 0) throw new Error(`dsh-browser: "${token}" is not a modifier; use one of ${MODIFIER_NAMES}, joined to the key with "+", such as "Control+A"`);
				modifiers |= bit;
			}
			if (MODIFIERS[last] !== void 0 && named.length > 0) throw new Error(`dsh-browser: "${chord}" names no key after its modifiers; write the key last, such as "Control+A"`);
			if (MODIFIERS[last] !== void 0) throw new Error(`dsh-browser: "${chord}" is a modifier with no key after it; write the key last, such as "Control+A"`);
			if (last === "") throw new Error(`dsh-browser: "${chord}" names no key after its modifiers; write the key last, such as "Control+A"`);
			const key = NAMED_KEYS[last];
			if (key !== void 0) {
				const text = (modifiers & SUPPRESSES_TEXT) === 0 ? key.text : void 0;
				return {
					key: last,
					code: key.code,
					keyCode: key.keyCode,
					text,
					modifiers
				};
			}
			if ([...last].length === 1) return characterStroke(last, modifiers);
			throw new Error(`dsh-browser: "${chord}" is not a dispatchable key; send a single character, or text through the text message`);
		}
		/**
		* Whether the host would dispatch this chord.
		*
		* The pane asks before it sends, and it must ask here rather than of its own
		* table: a chord the host refuses comes back on the same error frame the pane
		* uses for a browser in trouble, so a pane that guesses turns an ordinary
		* keypress — a lone modifier, a key this table does not carry — into a UI
		* failure. One table, one answer.
		* @param chord - a key name, a single character, or modifiers joined to either.
		* @returns true when `parseKeyStroke` resolves it, false when it would refuse.
		*/
		function isDispatchableKey(chord) {
			try {
				parseKeyStroke(chord);
				return true;
			} catch {
				return false;
			}
		}
		//#endregion
		//#region src/client/keys.ts
		/**
		* What one keydown in the pane becomes on the wire.
		*
		* The decision lives here rather than in the canvas that listens, because it is
		* the one piece of the pane's input path with a right answer: whether a
		* keystroke is text, a chord, or nothing at all. It asks the host's own
		* vocabulary (`../browser/keys.ts`) before naming a chord, so the pane cannot
		* ask for something the host will refuse — a refusal comes back on the frame the
		* pane reserves for a browser in trouble, which is how pressing Ctrl once came
		* to look like a broken browser.
		*/
		/**
		* The modifiers a key event is holding, spelled the way a chord writes them.
		* @param event - the key event.
		* @returns the modifier names, in the order a chord writes them.
		*/
		function modifiersOf(event) {
			const held = [];
			if (event.ctrlKey) held.push("Control");
			if (event.metaKey) held.push("Meta");
			if (event.altKey) held.push("Alt");
			if (event.shiftKey) held.push("Shift");
			return held;
		}
		/**
		* Resolve one keydown into the message the viewer channel carries.
		*
		* AltGr arrives as Control+Alt on Windows and still produces a character — a
		* German or Polish layout types its symbols that way — so it goes as text;
		* sending it as a chord would swallow the character the user meant to type. A
		* chord is a keystroke, not text: sending Ctrl+A as the character "a" is what
		* this path used to do, and a page that selects everything on Ctrl+A had an "a"
		* typed into it instead. And a key that is only a modifier resolves to nothing,
		* because a chord writes its key last: pressing Ctrl starts a chord rather than
		* being one.
		*
		* @param event - the keydown to resolve.
		* @returns the text or chord to send, or undefined when this key is nothing the
		* page can be sent.
		*/
		function keyMessage(event) {
			const altGraph = event.ctrlKey && event.altKey && event.key.length === 1;
			if (event.key.length === 1 && (!(event.ctrlKey || event.metaKey || event.altKey) || altGraph)) return {
				type: "text",
				text: event.key
			};
			const chord = [...modifiersOf(event), event.key].join("+");
			return isDispatchableKey(chord) ? {
				type: "key",
				key: chord
			} : void 0;
		}
		//#endregion
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
			settingsAdvanced: "Advanced",
			settingsAdvancedHint: "The browser works without changing any of these.",
			settingsAdvancedOverridden: "{count} changed",
			settingsGroupProcess: "Browser process",
			settingsGroupProcessHint: "Which binary opens, which ports it may listen on, and whether the automation markers stay hidden.",
			settingsGroupMirror: "Mirror and page size",
			settingsGroupMirrorHint: "Headless page size, and the JPEG quality the Sidebar shows.",
			settingsGroupSnapshot: "Agent snapshot",
			settingsGroupSnapshotHint: "What a snapshot prints beside each node's role and name.",
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
			settingsWidth: "Width",
			settingsHeight: "Height",
			settingsQuality: "Mirror quality (JPEG 1-100)",
			settingsDebugPortMin: "CDP port range — from",
			settingsDebugPortMax: "CDP port range — to",
			settingsDebugPortHint: "Every conversation gets its own browser and its own port, so this is the window those ports come from: the lowest free one goes first, and a browser that finds nothing free inside the window fails rather than listening outside it.",
			settingsSnapshotAttributes: "Properties printed per node",
			settingsSnapshotAttributesHint: "Comma-separated accessibility properties the snapshot prints beside a role and a name — url, level, placeholder, and so on. The default list is what changes what the agent can do; empty prints none.",
			settingsSnapshotIgnore: "Selectors no snapshot prints",
			settingsSnapshotIgnoreHint: "Comma-separated CSS selectors whose elements, and everything inside them, are left out of a snapshot. A page can exempt itself with data-dsh-browser-ignore; add more here, for example nav, footer.",
			settingsUnavailable: "Settings are unavailable in this deployment; the composed configuration is in force.",
			settingsLoading: "Loading settings…",
			settingsReset: "Reset",
			settingsApplied: "Launch settings restart the browser; snapshot settings apply to the next snapshot.",
			settingsStealth: "Automation markers",
			settingsStealthOn: "Hidden (recommended)",
			settingsStealthOff: "Left visible",
			settingsStealthNote: "Playwright-started browsers report navigator.webdriver and, headless, spell their user agent HeadlessChrome. Sites that check for automation block those: with the markers left visible Google served its \"unusual traffic\" page three times out of three, and none with them hidden.",
			settingsStatusReading: "Reading the browser state…",
			settingsStatusRunning: "{count} session browser(s) running",
			settingsStatusStarting: "{count} session browser(s) starting",
			settingsStatusNone: "No session browser is running — one starts when a conversation opens it.",
			settingsStatusUnknown: "The browser state could not be read: {error}",
			settingsSessionsCount: "Sessions with a browser ({count})",
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
			settingsAdvanced: "高级设置",
			settingsAdvancedHint: "不改这里也能正常使用。",
			settingsAdvancedOverridden: "{count} 项已自定义",
			settingsGroupProcess: "浏览器进程",
			settingsGroupProcessHint: "用哪个可执行文件、在哪个端口范围里监听、是否继续隐藏自动化标记。",
			settingsGroupMirror: "镜像与页面尺寸",
			settingsGroupMirrorHint: "无头下的页面尺寸，以及侧栏镜像的 JPEG 画质。",
			settingsGroupSnapshot: "Agent 快照",
			settingsGroupSnapshotHint: "快照在每个节点的 role 与 name 之外还打印什么。",
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
			settingsExecutable: "可执行文件路径（覆盖浏览器选择）",
			settingsWidth: "宽度",
			settingsHeight: "高度",
			settingsQuality: "镜像画质（JPEG 1-100）",
			settingsDebugPortMin: "CDP 端口范围（起）",
			settingsDebugPortMax: "CDP 端口范围（止）",
			settingsDebugPortHint: "每个对话各有一个浏览器、各自一个端口，所以这里给的是一个范围：从最小的空闲端口开始分配；范围里没有空端口时直接报错，而不会跑到范围外去监听。",
			settingsSnapshotAttributes: "每个节点打印的属性",
			settingsSnapshotAttributesHint: "快照在 role 与 name 之外打印的无障碍属性，用逗号分隔——url、level、placeholder 等。默认这一组决定了 agent 能做什么；留空则一个都不打印。",
			settingsSnapshotIgnore: "快照不打印的选择器",
			settingsSnapshotIgnoreHint: "这些 CSS 选择器匹配到的元素及其内部内容不会进入快照，用逗号分隔。页面自己可以用 data-dsh-browser-ignore 豁免；需要更多就在这里补，例如 nav, footer。",
			settingsUnavailable: "当前部署没有设置服务，使用组合配置。",
			settingsLoading: "正在载入设置…",
			settingsReset: "重置",
			settingsApplied: "启动项会重启浏览器；快照相关设置从下一次快照起生效。",
			settingsStealth: "自动化标记",
			settingsStealthOn: "隐藏（推荐）",
			settingsStealthOff: "保留",
			settingsStealthNote: "Playwright 启动的浏览器会报告 navigator.webdriver，无头时 UA 还写成 HeadlessChrome。做自动化检测的站点会因此拦截：保留标记时 Google 连续三次搜索全部被拦，隐藏后三次全部通过。",
			settingsStatusReading: "正在读取浏览器状态…",
			settingsStatusRunning: "{count} 个会话浏览器在运行",
			settingsStatusStarting: "{count} 个会话浏览器正在启动",
			settingsStatusNone: "当前没有会话浏览器在运行——某个对话用到时才会启动。",
			settingsStatusUnknown: "读不到浏览器状态：{error}",
			settingsSessionsCount: "有浏览器的会话（{count}）",
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
		* click. Which message a keystroke becomes — text, a chord, or nothing — is
		* decided in `keys.ts`, against the same key table the host dispatches from.
		*
		* Styles are inline: this plugin builds its client bundle outside the
		* repository's stylesheet pipeline, so a CSS import would have no owner.
		*/
		/** Absolute path the host serves the mirror on. */
		const STREAM_PATH = "/dsh-browser/stream";
		/** Milliseconds between forwarded pointer moves, so a drag does not flood the socket. */
		const MOVE_INTERVAL_MS = 33;
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
		/**
		* Put text on the system clipboard from the page the user is looking at.
		*
		* The async API is the first choice; a browser that refuses it outside its own
		* idea of a gesture still honours the older hidden-textarea route, which is the
		* fallback VS Code's web clipboard keeps as well. Focus is restored either way:
		* the temporary field is a document-wide side effect, and the user's next
		* keystroke belongs wherever it was going.
		* @param text - the text to place on the clipboard.
		*/
		async function writeClipboard(text) {
			try {
				await navigator.clipboard.writeText(text);
				return;
			} catch {}
			const previous = document.activeElement;
			const field = document.createElement("textarea");
			field.setAttribute("aria-hidden", "true");
			field.style.cssText = "position:absolute;left:-9999px;top:0;width:1px;height:1px";
			field.value = text;
			document.body.appendChild(field);
			field.select();
			try {
				document.execCommand("copy");
			} finally {
				field.remove();
				if (previous instanceof HTMLElement) previous.focus();
			}
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
			pasteSink: {
				position: "absolute",
				left: "-9999px",
				top: 0,
				width: "1px",
				height: "1px",
				padding: 0,
				border: "none",
				opacity: 0,
				resize: "none"
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
		function BrowserBody({ sessionId, t, useTabInfo }) {
			const copy = copyOf(t);
			const tab = useTabInfo?.();
			const canvasRef = (0, react.useRef)(null);
			const socketRef = (0, react.useRef)(void 0);
			const lastMoveRef = (0, react.useRef)(0);
			const pasteSinkRef = (0, react.useRef)(null);
			/**
			* What to do with the selection the mirror is about to report.
			*
			* The copy is armed here, on the keystroke, and spent when the answer arrives:
			* the answer is a round trip away, and the chord is what says whether there is
			* anything to write at all.
			*/
			const clipboardRef = (0, react.useRef)(void 0);
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
					if (parsed.type === "clipboard") {
						const settle = clipboardRef.current;
						clipboardRef.current = void 0;
						settle?.(String(parsed.text ?? ""));
					}
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
			* Arm the clipboard for the chord just pressed.
			*
			* A copy with nothing selected must leave the clipboard alone, and only the
			* mirror knows what is selected, so the write waits for its answer:
			* {@link clipboardReply} is the decision, and this is only where it lands.
			* @param chord - the reading chord that was pressed.
			*/
			const armClipboard = (0, react.useCallback)((chord) => {
				clipboardRef.current = (text) => {
					const reply = clipboardReply(chord, text);
					if (reply.write !== void 0) writeClipboard(reply.write);
					if (reply.after !== void 0) sendInput(reply.after);
				};
			}, [sendInput]);
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
								children: secure ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									width: "14",
									height: "14",
									viewBox: "0 0 16 16",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "1.3",
									strokeLinecap: "round",
									strokeLinejoin: "round",
									"aria-hidden": "true",
									children: LOCK_ICON
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineMedium, { size: 14 })
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
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
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
									const chord = clipboardChord(event);
									if (chord === "paste") {
										pasteSinkRef.current?.focus();
										return;
									}
									if (chord !== void 0) {
										event.preventDefault();
										armClipboard(chord);
										send({ type: "selection" });
										return;
									}
									const message = keyMessage(event);
									if (message === void 0) return;
									sendInput(message);
									event.preventDefault();
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								ref: pasteSinkRef,
								"aria-hidden": "true",
								tabIndex: -1,
								value: "",
								style: style.pasteSink,
								onChange: () => {},
								onPaste: (event) => {
									const text = event.clipboardData.getData("text");
									event.preventDefault();
									canvasRef.current?.focus();
									const message = pasteMessage(text);
									if (message !== void 0) sendInput(message);
								}
							}),
							note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
							})
						]
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
								tab?.tab.actions.close();
							},
							children: copy("closeBrowser")
						}) : null]
					})
				]
			});
		}
		//#endregion
		//#region src/client/chip.ts
		/**
		* How the browser's glyph is placed inside a chip title.
		*
		* The chip's title row (`[data-dockkit-tab-title]`) is already
		* `display: flex; gap: 5px; align-items: center`, and it reaches registrants
		* through a `display: contents` slot wrapper — so the harness's own chips hand
		* it a bare `<svg>`: a flex item, blockified, centred on the row's line, one
		* 5px gap from the label.
		*
		* This bundle has no stylesheet of its own, so the wrapper below is where that
		* has to be said instead. It exists for `flex: 0 0 auto` (without it a long
		* label shrinks the globe) and must add nothing else. Two measured ways of
		* getting it wrong, both seen on 2026-09-24 with the pane open in the GUI:
		*
		* - `display: inline-block` wrapping the icon leaves the *svg* inline, sitting
		*   on the wrapper's first baseline while the row centres the wrapper — an
		*   18.2px line box for a 14px glyph, 2.1px above the label's centre.
		* - `margin-right` here doubles the row's gap: 10px from the label against the
		*   sibling chips' 5px.
		*
		* `verticalAlign` is not part of it either: its wrapper is a block-level flex
		* item, where the property has no effect (which is why `-3px` never moved the
		* glyph that looked high).
		*/
		const CHIP_GLYPH = {
			display: "flex",
			alignItems: "center",
			flex: "0 0 auto"
		};
		//#endregion
		//#region src/client/title.tsx
		/**
		* The title as the chip and a floating panel's header show it.
		* @param props - the tab information hook.
		* @returns the globe followed by the tab's title text.
		*/
		function BrowserTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: CHIP_GLYPH,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular, { size: 16 })
			}), tab.title] });
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
		//#region src/client/definition.ts
		/** The tab kind this plugin owns. */
		const BROWSER_KIND = "cdpBrowser";
		/** This implementation's identity: the key its body and title register under. */
		const BROWSER_ID = "dsh-browser";
		/**
		* The mirror's registry definition.
		*
		* The guide entry carries the glyph the caller hands in: without one the guide
		* draws its cube placeholder, which says nothing about what picking the entry
		* opens. The chip draws the same glyph through this module's own title
		* registrant, so the two places the user meets the browser agree on what it
		* looks like.
		* @param title - the tab chip's text in the current language.
		* @param guideTitle - the guide entry's title in the current language.
		* @param guideDescription - the guide entry's one-line description.
		* @param icon - the browser's glyph, supplied by the caller so this module stays
		* loadable outside the bundle (see `glyph.ts`).
		* @returns the definition to register.
		*/
		function browserDefinition(title, guideTitle, guideDescription, icon) {
			return {
				id: BROWSER_ID,
				kind: BROWSER_KIND,
				priority: "extension",
				title,
				guide: [{
					id: BROWSER_ID,
					order: 40,
					title: guideTitle,
					description: guideDescription,
					icon
				}]
			};
		}
		//#endregion
		//#region src/client/reveal.ts
		/** How long the pane waits between looks at the host's browser state. */
		const POLL_MS = 1500;
		/**
		* Whether a browser is up and asking to be watched.
		* @param state - the reported state, or `undefined` while the Session has no browser.
		* @returns whether a browser is starting or running.
		*/
		function running(state) {
			return state === "starting" || state === "ready";
		}
		/**
		* Whether a status change is the moment to bring the pane forward.
		*
		* A Session the route has never reported counts as not running, which is what
		* makes the first tool call of a conversation reveal the browser: the instance
		* appears in the report the moment a tool asks the pool for it. The cost of that
		* choice is that a browser already running when the client loads — a page reload
		* during a long turn — reveals itself too, which is the same story told late.
		* @param previous - the state last reported for this Session.
		* @param next - the state reported now.
		* @returns whether a browser that was not running is running now.
		*/
		function justStarted(previous, next) {
			return !running(previous) && running(next);
		}
		/**
		* Follow the host's browser state for the mounted Session, and open the browser's
		* pane when a browser starts.
		* @param ctx - client context carrying the Sidebar's navigation face.
		*/
		function revealOnBrowserStart(ctx) {
			ctx.effect(() => {
				/** The state last reported for each Session, so a start is visible as a change. */
				const seen = /* @__PURE__ */ new Map();
				let timer;
				let looking = false;
				let stopped = false;
				/** Whether the mounted Session already shows this browser in its pane. */
				const watched = (sessionId) => ctx.sidebarRight.tabsIn(sessionId).some((tab) => tab.kind === BROWSER_KIND);
				/** Read the host's state once, and open the pane if a browser just started. */
				const look = async () => {
					const sessionId = ctx.sidebarRight.mounted.getSnapshot();
					if (sessionId === void 0 || looking || stopped || watched(sessionId)) return;
					looking = true;
					try {
						const report = await browserStatus();
						if (stopped) return;
						for (const instance of report.instances) {
							const previous = seen.get(instance.sessionId);
							seen.set(instance.sessionId, instance.state);
							if (instance.sessionId !== sessionId) continue;
							if (justStarted(previous, instance.state)) ctx.sidebarRight.openTabIn(sessionId, BROWSER_KIND);
						}
					} catch {} finally {
						looking = false;
					}
				};
				const follow = () => {
					if (timer !== void 0) clearInterval(timer);
					timer = setInterval(() => {
						look();
					}, POLL_MS);
					look();
				};
				const unsubscribe = ctx.sidebarRight.mounted.subscribe(follow);
				follow();
				return () => {
					stopped = true;
					unsubscribe();
					if (timer !== void 0) clearInterval(timer);
				};
			}, "dsh-browser: reveal the pane when a browser starts");
		}
		//#endregion
		//#region src/client/settings-layout.ts
		/**
		* The blocks inside the fold, in page order.
		*
		* This list is the page's structure, not a hint: a group missing from it would
		* have its fields placed but never rendered, which the tests reject. A group is
		* folded as a whole — splitting one would leave a heading with nothing under it
		* in the visible tier.
		*/
		const ADVANCED_GROUPS = [
			"process",
			"mirror",
			"snapshot"
		];
		/**
		* Every editable field, in the order the page renders it.
		*
		* The set is exactly the volatile half of the configuration schema — a field the
		* loader lets the settings page write has to appear here, and
		* `test/settings-layout.test.ts` fails when the two lists drift apart.
		*/
		const FIELD_PLACEMENTS = [
			{
				field: "headless",
				group: "everyday"
			},
			{
				field: "channel",
				group: "everyday"
			},
			{
				field: "userDataDir",
				group: "everyday"
			},
			{
				field: "stealth",
				group: "process"
			},
			{
				field: "executablePath",
				group: "process"
			},
			{
				field: "debugPortMin",
				group: "process"
			},
			{
				field: "debugPortMax",
				group: "process"
			},
			{
				field: "viewportWidth",
				group: "mirror"
			},
			{
				field: "viewportHeight",
				group: "mirror"
			},
			{
				field: "quality",
				group: "mirror"
			},
			{
				field: "snapshotAttributes",
				group: "snapshot"
			},
			{
				field: "snapshotIgnore",
				group: "snapshot"
			}
		];
		/**
		* Copy for every placed field.
		*
		* A separate table from {@link FIELD_PLACEMENTS} because the order the page
		* renders in and the words it uses are different concerns that happen to share a
		* key; keeping the record total means a new field cannot appear unlabelled.
		*/
		const FIELD_COPY = {
			headless: {
				label: "settingsMode",
				hint: "settingsHeadlessNote"
			},
			channel: { label: "settingsBrowser" },
			userDataDir: { label: "settingsProfile" },
			stealth: {
				label: "settingsStealth",
				hint: "settingsStealthNote"
			},
			executablePath: { label: "settingsExecutable" },
			debugPortMin: {
				label: "settingsDebugPortMin",
				hint: "settingsDebugPortHint"
			},
			debugPortMax: { label: "settingsDebugPortMax" },
			viewportWidth: { label: "settingsWidth" },
			viewportHeight: { label: "settingsHeight" },
			quality: { label: "settingsQuality" },
			snapshotAttributes: {
				label: "settingsSnapshotAttributes",
				hint: "settingsSnapshotAttributesHint"
			},
			snapshotIgnore: {
				label: "settingsSnapshotIgnore",
				hint: "settingsSnapshotIgnoreHint"
			}
		};
		/** The heading and one-line explanation of a block inside the fold. */
		const GROUP_COPY = {
			process: {
				title: "settingsGroupProcess",
				hint: "settingsGroupProcessHint"
			},
			mirror: {
				title: "settingsGroupMirror",
				hint: "settingsGroupMirrorHint"
			},
			snapshot: {
				title: "settingsGroupSnapshot",
				hint: "settingsGroupSnapshotHint"
			}
		};
		/** The row that continues the profile field once a directory is wanted. */
		const PROFILE_DIR_COPY = {
			label: "settingsProfileDir",
			hint: "settingsProfileDirHint"
		};
		/**
		* The placements of one block, in page order.
		* @param group - the block to render.
		* @returns its fields, in the order they are declared.
		*/
		function placementsIn(group) {
			return FIELD_PLACEMENTS.filter((placement) => placement.group === group);
		}
		/**
		* The fields behind the fold, in page order.
		* @returns every folded placement.
		*/
		function foldedPlacements() {
			return ADVANCED_GROUPS.flatMap((group) => placementsIn(group));
		}
		/**
		* How many of these fields the user layer holds.
		*
		* The fold hides its fields' controls, and with them their reset buttons, so a
		* change made inside it would otherwise be invisible from the collapsed page.
		* @param user - the user's own settings layer, as the form reports it.
		* @param placements - the fields to look at.
		* @returns the number of them the user has overridden.
		*/
		function overriddenCount(user, placements) {
			return placements.filter((placement) => Object.hasOwn(user, placement.field)).length;
		}
		/**
		* The line the fold shows while closed.
		* @param t - copy for this namespace.
		* @param overridden - how many hidden fields the user has changed.
		* @returns the summary, mentioning them when there are any.
		*/
		function advancedSummary(t, overridden) {
			const title = t("settingsAdvanced");
			if (overridden === 0) return title;
			return `${title} · ${t("settingsAdvancedOverridden").replace("{count}", String(overridden))}`;
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
		* Which fields exist, where they sit, and what they are called all come from
		* `settings-layout.ts`: this file only turns each placement into a control. That
		* split is what keeps a new configuration field from slipping onto the page
		* unlabelled or missing entirely, and it is what the tests can reach.
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
				wordBreak: "break-all",
				display: "block"
			},
			statusSummary: {
				fontSize: "11px",
				opacity: .65,
				cursor: "pointer"
			},
			statusFailed: { color: "var(--dsh-danger, #e06c75)" },
			fold: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				borderTop: "1px solid rgba(128,128,128,0.25)",
				paddingTop: "12px"
			},
			foldSummary: {
				cursor: "pointer",
				fontSize: "13px",
				opacity: .9
			},
			block: {
				display: "flex",
				flexDirection: "column",
				gap: "10px"
			},
			blockDivided: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				borderTop: "1px solid rgba(128,128,128,0.16)",
				paddingTop: "12px"
			},
			blockTitle: {
				margin: 0,
				fontSize: "12px",
				fontWeight: 600,
				opacity: .85
			},
			blockHint: {
				margin: 0,
				fontSize: "11px",
				opacity: .6,
				lineHeight: 1.5
			},
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
		/**
		* A control is missing.
		*
		* This only compiles while the caller's switch covers every field of
		* {@link BrowserSettingsView}, so adding a configuration field fails the build
		* here until it gets a control — the runtime throw is a backstop that never
		* runs in a build that passed.
		* @param field - the field nothing renders.
		* @returns never.
		*/
		function unreachableField(field) {
			throw new Error(`no control for ${String(field)}`);
		}
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
		/** One block inside the fold: what it covers, then its rows. */
		function Block(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"aria-label": props.title,
				style: props.divided ? styles.blockDivided : styles.block,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.blockTitle,
						children: props.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.blockHint,
						children: props.hint
					}),
					props.children
				]
			});
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
			/** The control one placed field renders. */
			const control = (field) => {
				switch (field) {
					case "headless": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
					});
					case "channel": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
					});
					case "userDataDir": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
					});
					case "stealth": return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
					});
					case "executablePath": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.input,
						value: value.executablePath,
						spellCheck: false,
						onChange: (event) => {
							write("executablePath", event.target.value);
						}
					});
					case "debugPortMin": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.number,
						type: "number",
						min: 1,
						max: 65535,
						value: value.debugPortMin,
						onChange: (event) => {
							write("debugPortMin", Number(event.target.value));
						}
					});
					case "debugPortMax": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.number,
						type: "number",
						min: 1,
						max: 65535,
						value: value.debugPortMax,
						onChange: (event) => {
							write("debugPortMax", Number(event.target.value));
						}
					});
					case "viewportWidth": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.number,
						type: "number",
						min: 320,
						max: 3840,
						value: value.viewportWidth,
						onChange: (event) => {
							write("viewportWidth", Number(event.target.value));
						}
					});
					case "viewportHeight": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.number,
						type: "number",
						min: 240,
						max: 2160,
						value: value.viewportHeight,
						onChange: (event) => {
							write("viewportHeight", Number(event.target.value));
						}
					});
					case "quality": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.number,
						type: "number",
						min: 1,
						max: 100,
						value: value.quality,
						onChange: (event) => {
							write("quality", Number(event.target.value));
						}
					});
					case "snapshotAttributes": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.input,
						value: value.snapshotAttributes,
						spellCheck: false,
						onChange: (event) => {
							write("snapshotAttributes", event.target.value);
						}
					});
					case "snapshotIgnore": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						style: styles.input,
						value: value.snapshotIgnore,
						spellCheck: false,
						onChange: (event) => {
							write("snapshotIgnore", event.target.value);
						}
					});
				}
				return unreachableField(field);
			};
			/** One placed field as a labelled row. */
			const placedRow = (placement) => {
				const copy = FIELD_COPY[placement.field];
				return row(t(copy.label), placement.field, control(placement.field), copy.hint === void 0 ? void 0 : t(copy.hint));
			};
			const hiddenChanges = overriddenCount(user, foldedPlacements());
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
							}), (status?.instances.length ?? 0) === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
								style: styles.statusSummary,
								children: t("settingsSessionsCount").replace("{count}", String(status?.instances.length ?? 0))
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
						children: [placementsIn("everyday").map((placement) => placedRow(placement)), persistent ? row(t(PROFILE_DIR_COPY.label), "userDataDir", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							value: value.userDataDir,
							spellCheck: false,
							placeholder: "D:\\\\chrome-profile",
							onChange: (event) => {
								setPersistentChoice(true);
								write("userDataDir", event.target.value);
							}
						}), PROFILE_DIR_COPY.hint === void 0 ? void 0 : t(PROFILE_DIR_COPY.hint)) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						style: styles.fold,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
								style: styles.foldSummary,
								children: advancedSummary(t, hiddenChanges)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: styles.note,
								children: t("settingsAdvancedHint")
							}),
							ADVANCED_GROUPS.map((group, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Block, {
								title: t(GROUP_COPY[group].title),
								hint: t(GROUP_COPY[group].hint),
								divided: index > 0,
								children: placementsIn(group).map((placement) => placedRow(placement))
							}, group))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.note,
						children: t("settingsApplied")
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required browser services: the tab registry, its navigation face, the slot registry, and copy. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs",
			"sidebarRight"
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
			ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(() => t("title"), () => t("guideTitle"), () => t("guideDescription"), _deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular)), "dsh-browser: cdpBrowser type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: BROWSER_ID,
				locale: NS,
				inject: (sessionId) => ({ sessionId })
			}, BrowserBody)), "dsh-browser: viewer body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: BROWSER_ID
			}, BrowserTitle)), "dsh-browser: viewer title");
			revealOnBrowserStart(ctx);
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