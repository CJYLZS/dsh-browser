import { chromium } from "playwright-core";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
//#region src/browser/launch.ts
/**
* Start the browser and make its external CDP listener usable.
*
* Two facts measured during M1 shape this module:
*
* - Playwright keeps its own control channel on `--remote-debugging-pipe`, and
*   an extra `--remote-debugging-port` still makes Chrome listen on that port
*   (verified against `/json/version`). That port is what lets DevTools or
*   another Playwright attach to the same browser.
* - Because the pipe is present, Chrome does NOT write `DevToolsActivePort` in
*   the profile, so the port cannot be discovered from disk. The port is
*   therefore a configuration value, and readiness is proven by polling
*   `/json/version`.
*/
/**
* Sleep for a fixed time.
* @param ms - milliseconds.
* @returns a promise settling after the delay.
*/
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/**
* Poll the external listener until it answers.
*
* The browser is already running when this is called; a port that never answers
* means the launch arguments did not take effect, which must fail loud rather
* than leave a mirror that silently cannot be attached to.
* @param port - the configured CDP port.
* @param timeoutMs - budget before failing.
* @returns the reported browser version string.
* @throws {Error} when nothing answers within the budget.
*/
async function waitForDebugPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = "no attempt made";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2e3) });
			if (response.ok) {
				const body = await response.json();
				return typeof body.Browser === "string" ? body.Browser : "unknown";
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(150);
	}
	throw new Error(`dsh-browser: the external CDP port ${port} never answered /json/version (${lastError}); another process may hold the port, or the browser refused --remote-debugging-port`);
}
/**
* Launch the persistent browser and wait for its CDP listener.
* @param config - resolved plugin configuration.
* @param userDataDir - profile directory to open (temporary or configured).
* @param timeoutMs - budget for the listener to answer.
* @returns the running session.
*/
async function launchBrowser(config, userDataDir, timeoutMs = 2e4) {
	const args = [
		`--remote-debugging-port=${config.debugPort}`,
		"--no-first-run",
		"--no-default-browser-check",
		...config.extraArgs
	];
	if (config.stealth) args.push("--disable-blink-features=AutomationControlled");
	if (!config.headless) args.push("--disable-features=CalculateNativeWinOcclusion");
	const context = await chromium.launchPersistentContext(userDataDir, {
		headless: config.headless,
		viewport: config.headless ? {
			width: config.viewportWidth,
			height: config.viewportHeight
		} : null,
		args,
		...config.executablePath === "" ? { channel: config.channel } : { executablePath: config.executablePath }
	});
	const version = await waitForDebugPort(config.debugPort, timeoutMs);
	return {
		context,
		debugPort: config.debugPort,
		version
	};
}
/**
* Ask the operating system whether a port is free on loopback.
*
* The listener is closed again before this resolves, so the answer is about
* availability at this instant; callers that need the port for longer hold it
* through {@link PortAllocator}.
* @param port - the port to test.
* @returns whether the port could be bound.
*/
async function canBind(port) {
	return await new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => {
			resolve(false);
		});
		server.once("listening", () => {
			server.close(() => {
				resolve(true);
			});
		});
		server.listen(port, "127.0.0.1");
	});
}
/**
* Assigns CDP ports and remembers which ones are spoken for.
*
* Allocation is serialised: two sessions asking at the same time would
* otherwise both see the same port free and both take it.
*/
var PortAllocator = class {
	held;
	pending = Promise.resolve();
	base;
	probe;
	/**
	* @param base - the configured first port.
	* @param taken - ports known to be in use already.
	* @param probe - availability test, replaced in tests.
	*/
	constructor(base, taken = [], probe = canBind) {
		this.base = base;
		this.held = new Set(taken);
		this.probe = probe;
	}
	/**
	* Take the lowest free port.
	* @returns the port, held for this allocator until {@link release}.
	* @throws {Error} when no port in the scan range is free.
	*/
	async allocate() {
		const attempt = this.pending.then(async () => await this.search());
		this.pending = attempt.catch(() => {});
		return await attempt;
	}
	/**
	* Give a port back, so a later browser may take it.
	* @param port - the port whose browser is gone.
	*/
	release(port) {
		this.held.delete(port);
	}
	/**
	* Change where the next search starts, after the configured port changed.
	*
	* Ports already held stay held: the browsers listening on them are still
	* running, whatever the configuration now says.
	* @param base - the newly configured first port.
	*/
	setBase(base) {
		this.base = base;
	}
	/** Ports currently held, for diagnostics. */
	get heldPorts() {
		return [...this.held];
	}
	/** Probe upward until a port answers free. */
	async search() {
		for (let offset = 0; offset < 100; offset++) {
			const port = this.base + offset;
			if (port > 65535) break;
			if (this.held.has(port)) continue;
			if (!await this.probe(port)) continue;
			this.held.add(port);
			return port;
		}
		throw new Error(`dsh-browser: no free port for the CDP listener in ${this.base}-${this.base + 100 - 1}; another process holds them, or too many session browsers are running`);
	}
};
//#endregion
//#region src/browser/aria.ts
/** Nodes printed when the caller sets no budget. */
const DEFAULT_MAX_NODES = 300;
/** States worth printing, in the order they appear on a line. */
const STATES = [
	"checked",
	"disabled",
	"expanded",
	"selected",
	"required"
];
/** Render one node's name for display inside quotes. */
function quoted(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
/** Read a CDP value field, which is `unknown` because the protocol allows any type. */
function text(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
/** The states this node reports, rendered for the line. */
function statesOf(node) {
	const reported = /* @__PURE__ */ new Map();
	for (const property of node.properties ?? []) {
		if (property.name === void 0) continue;
		reported.set(property.name, text(property.value?.value));
	}
	const rendered = [];
	for (const name of STATES) {
		const value = reported.get(name);
		if (value === "true") rendered.push(`[${name}]`);
		else if (value === "mixed") rendered.push(`[${name}=mixed]`);
	}
	return rendered.length === 0 ? "" : ` ${rendered.join(" ")}`;
}
/** One node rendered as its own line, without indentation. */
function lineOf(node, ref) {
	const role = text(node.role?.value) || "node";
	const name = text(node.name?.value);
	const value = text(node.value?.value);
	return `- ${role}${name === "" ? "" : ` ${quoted(name)}`}${value === "" ? "" : ` value=${quoted(value)}`}` + statesOf(node) + `${ref === void 0 ? "" : ` [ref=${ref}]`}`;
}
/**
* Print an accessibility tree.
*
* Traversal is depth-first in the tree's own child order, which is what makes
* ref labels stable between two snapshots of an unchanged page. Nodes the
* caller's budget could not fit are counted, not silently dropped.
* @param nodes - the flat node list CDP returns.
* @param options - node budget.
* @returns the text, the ref labels it used, and whether it truncated.
*/
function formatAxTree(nodes, options = {}) {
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const byId = /* @__PURE__ */ new Map();
	for (const node of nodes) if (node.nodeId !== void 0) byId.set(node.nodeId, node);
	const isChild = /* @__PURE__ */ new Set();
	for (const node of nodes) for (const child of node.childIds ?? []) isChild.add(child);
	const roots = nodes.filter((node) => node.nodeId === void 0 || !isChild.has(node.nodeId));
	const lines = [];
	const refs = /* @__PURE__ */ new Map();
	let printed = 0;
	let skipped = 0;
	/**
	* Print one node and its children.
	* @param node - the node to print.
	* @param depth - indentation level.
	*/
	const visit = (node, depth) => {
		const backendNodeId = node.backendDOMNodeId;
		const ref = backendNodeId === void 0 || node.ignored === true ? void 0 : `e${String(refs.size + 1)}`;
		if (node.ignored !== true) {
			if (printed < maxNodes) {
				if (ref !== void 0 && backendNodeId !== void 0) refs.set(ref, backendNodeId);
				lines.push(`${"  ".repeat(depth)}${lineOf(node, ref)}`);
				printed += 1;
			} else skipped += 1;
		}
		const childDepth = node.ignored === true ? depth : depth + 1;
		for (const childId of node.childIds ?? []) {
			const child = byId.get(childId);
			if (child !== void 0) visit(child, childDepth);
		}
	};
	for (const root of roots) visit(root, 0);
	return {
		text: skipped === 0 ? lines.join("\n") : `${lines.join("\n")}\n… ${String(skipped)} more nodes`,
		refs,
		truncated: skipped > 0
	};
}
/**
* The centre of a content quad, in the coordinates CDP reported it in.
*
* A quad is four corner pairs; their average is a point inside the element for
* every quad a browser produces, including one rotated by a CSS transform,
* where the midpoint of the bounding box would be outside it.
* @param quad - eight numbers, `x1 y1 x2 y2 x3 y3 x4 y4`.
* @returns the centre point.
*/
function centerOfQuad(quad) {
	const points = [];
	for (let index = 0; index + 1 < quad.length; index += 2) points.push({
		x: quad[index] ?? 0,
		y: quad[index + 1] ?? 0
	});
	if (points.length === 0) throw new Error("dsh-browser: the element reported no box to click");
	const sum = points.reduce((total, point) => ({
		x: total.x + point.x,
		y: total.y + point.y
	}), {
		x: 0,
		y: 0
	});
	return {
		x: sum.x / points.length,
		y: sum.y / points.length
	};
}
/** Characters that can appear in a path segment as themselves. */
const SAFE = /^[A-Za-z0-9._-]$/;
/**
* Encode one session id as a single path segment.
* @param sessionId - the session id, as the harness minted it.
* @returns a segment that names one directory and cannot traverse.
* @throws {Error} when the id is empty.
*/
function encodeSessionSegment(sessionId) {
	if (sessionId.length === 0) throw new Error("dsh-browser: cannot name a profile directory after an empty session id");
	if (sessionId === ".") return "~002E";
	if (sessionId === "..") return "~002E~002E";
	let encoded = "";
	for (const character of sessionId) encoded += character !== "~" && SAFE.test(character) ? character : `~${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "0000"}`;
	if (encoded.length <= 96) return encoded;
	const suffix = `~${hash(sessionId)}`;
	return encoded.slice(0, 96 - suffix.length) + suffix;
}
/**
* Stable short hash of an id, used only to keep truncated segments distinct.
* @param value - the id being hashed.
* @returns eight hexadecimal digits.
*/
function hash(value) {
	let state = 2166136261;
	for (let index = 0; index < value.length; index++) state = Math.imul(state ^ value.charCodeAt(index), 16777619) >>> 0;
	return state.toString(16).padStart(8, "0");
}
/**
* The profile directory one session's browser opens.
* @param base - the configured parent directory.
* @param sessionId - the session owning the browser.
* @returns the directory, which the caller creates by launching into it.
*/
function profileDirFor(base, sessionId) {
	return join(base, encodeSessionSegment(sessionId));
}
//#endregion
//#region src/browser/screencast.ts
/**
* Begin mirroring a page.
*
* The returned stopper removes this module's listener before asking Chrome to
* stop, so a frame arriving during teardown cannot be counted or forwarded.
* @param session - CDP session attached to the mirrored page.
* @param options - encoding settings.
* @param onFrame - receives every acknowledged frame.
* @param onError - receives acknowledgement failures, which otherwise stop the stream silently.
* @returns the stopper for this stream.
*/
async function startScreencast(session, options, onFrame, onError) {
	const handler = (event) => {
		session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(onError);
		onFrame({
			jpeg: Buffer.from(event.data, "base64"),
			deviceWidth: event.metadata?.deviceWidth ?? 0,
			deviceHeight: event.metadata?.deviceHeight ?? 0
		});
	};
	session.on("Page.screencastFrame", handler);
	await session.send("Page.startScreencast", {
		format: "jpeg",
		quality: options.quality,
		maxWidth: options.maxWidth,
		maxHeight: options.maxHeight,
		everyNthFrame: options.everyNthFrame
	});
	return async () => {
		session.off("Page.screencastFrame", handler);
		await session.send("Page.stopScreencast");
	};
}
//#endregion
//#region src/browser/input.ts
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
* Resolve a message's normalised position against the page's viewport.
*
* Viewers send fractions of the frame, so their own size never enters the
* protocol; CDP takes CSS pixels. Messages without a position pass through
* unchanged, since they carry nothing to scale — this is the whole of the
* difference between a viewer's coordinates and the page's.
* @param message - the decoded viewer message.
* @param size - the page's CSS viewport.
* @returns the message with pixel coordinates, or the same message.
*/
function scaleToViewport(message, size) {
	switch (message.type) {
		case "mouse": return {
			...message,
			x: message.x * size.width,
			y: message.y * size.height
		};
		case "wheel": return {
			...message,
			x: message.x * size.width,
			y: message.y * size.height
		};
		default: return message;
	}
}
/**
* Apply one viewer message to the mirrored page.
* @param session - CDP session attached to the mirrored page.
* @param message - the decoded viewer message.
* @throws {Error} when the message names a key with no dispatch mapping.
*/
async function dispatchInput(session, message) {
	switch (message.type) {
		case "mouse": {
			const button = message.action === "move" ? "none" : message.button ?? "left";
			await session.send("Input.dispatchMouseEvent", {
				type: message.action === "move" ? "mouseMoved" : message.action === "down" ? "mousePressed" : "mouseReleased",
				x: message.x,
				y: message.y,
				button,
				clickCount: message.action === "move" ? 0 : message.clickCount ?? 1
			});
			return;
		}
		case "wheel":
			await session.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: message.x,
				y: message.y,
				deltaX: message.deltaX,
				deltaY: message.deltaY
			});
			return;
		case "text":
			await session.send("Input.insertText", { text: message.text });
			return;
		case "key": {
			const named = NAMED_KEYS[message.key];
			if (named === void 0) throw new Error(`dsh-browser: "${message.key}" is not a dispatchable key; send text through the text message`);
			const base = {
				key: message.key,
				code: named.code,
				windowsVirtualKeyCode: named.keyCode,
				nativeVirtualKeyCode: named.keyCode
			};
			await session.send("Input.dispatchKeyEvent", {
				...base,
				type: named.text === void 0 ? "rawKeyDown" : "keyDown",
				...named.text === void 0 ? {} : { text: named.text }
			});
			await session.send("Input.dispatchKeyEvent", {
				...base,
				type: "keyUp"
			});
			return;
		}
	}
}
//#endregion
//#region src/browser/session-browser.ts
/**
* One session's browser: its process, its profile, its pages, its viewers.
*
* Every conversation that uses the browser gets one of these, and nothing it
* does is visible to another session — a link opened in one conversation does
* not appear in the next one's tabs, and neither does a login. The cost is the
* one a browser charges for it: profiles are per session, so a site signed into
* in one conversation starts signed out in another.
*
* Launch is lazy and single-flight: the first viewer or tool call starts the
* process, and concurrent callers join the same start. Frame production follows
* the viewer count — `Page.startScreencast` is repaint-driven and costs the
* renderer every frame, so a mirror nobody watches keeps the browser alive but
* stops streaming.
*/
/** How long a measured viewport is trusted before it is read again, in milliseconds. */
const VIEWPORT_TTL_MS = 1e3;
/** What a browser that vanished without being asked to is reported as. */
const DIED_REASON = "the browser was closed or crashed";
/** Fields a running browser was launched from; changing one requires a new browser. */
const LAUNCH_FIELDS = [
	"channel",
	"executablePath",
	"headless",
	"userDataDir",
	"debugPort",
	"viewportWidth",
	"viewportHeight",
	"startupUrl",
	"stealth"
];
/** Whether two configurations would start the same browser. */
function sameLaunch(left, right) {
	return LAUNCH_FIELDS.every((field) => left[field] === right[field]) && left.extraArgs.join("\0") === right.extraArgs.join("\0");
}
/** Whether two configurations encode frames the same way. */
function sameEncoding(left, right) {
	return left.quality === right.quality && left.maxWidth === right.maxWidth && left.maxHeight === right.maxHeight && left.everyNthFrame === right.everyNthFrame;
}
/**
* Replace the user agent a headless build reports with the one its headful
* build reports.
*
* Headless Chrome spells itself `HeadlessChrome/…`; the rest of the string is
* byte-for-byte what the same build sends with a window, so the reported value
* is edited rather than composed — no build number is guessed. `Network`'s
* override is what makes the change reach requests; editing `navigator` alone
* would leave the header intact.
* @param cdp - session attached to the page.
* @param page - page whose user agent is being replaced.
*/
async function hideHeadlessUserAgent(cdp, page) {
	const reported = await page.evaluate(() => navigator.userAgent).catch(() => "");
	if (!reported.includes("Headless")) return;
	await cdp.send("Network.setUserAgentOverride", { userAgent: reported.replace("Headless", "") });
}
/**
* One session's browser, from its first use to its disposal.
*/
var SessionBrowser = class {
	/** Pages the browser holds open, for the tab list a tool result carries. */
	viewers = /* @__PURE__ */ new Set();
	watchers = /* @__PURE__ */ new Set();
	sessionId;
	ports;
	launch;
	logger;
	config;
	state = "idle";
	reason;
	session;
	page;
	cdp;
	port;
	temporaryProfile;
	launchedHeadless;
	starting;
	stream;
	viewport;
	/** Refs the latest snapshot handed out, by label, for the next click or type. */
	refs = /* @__PURE__ */ new Map();
	/** Set while this class itself is closing the browser, so it is not a death. */
	closing = false;
	/**
	* @param sessionId - the session this browser belongs to.
	* @param deps - configuration, port owner, launcher, and logger.
	*/
	constructor(sessionId, deps) {
		this.sessionId = sessionId;
		this.config = deps.config;
		this.ports = deps.ports;
		this.launch = deps.launch;
		this.logger = deps.logger;
	}
	/**
	* Adopt a new configuration.
	*
	* A field the running browser was launched from closes it: viewers keep their
	* subscription, and the next frame request starts a browser built from the
	* new values. Frames are restarted in place, since only the stream's own
	* encoding changed.
	* @param next - the newly resolved configuration.
	* @returns after the browser has been restarted, when it had to be.
	*/
	async reconfigure(next) {
		const previous = this.config;
		this.config = next;
		if (this.state !== "ready" && this.state !== "starting") return;
		if (!sameLaunch(previous, next)) {
			this.logger.info("dsh-browser: launch configuration changed; restarting the browser");
			await this.close();
			await this.openStreamForViewers();
			return;
		}
		if (!sameEncoding(previous, next) && this.viewers.size > 0) {
			await this.closeStream();
			await this.openStream();
		}
	}
	/** The current status snapshot. */
	status() {
		const pages = this.session?.context.pages() ?? [];
		return {
			sessionId: this.sessionId,
			state: this.state,
			debugPort: this.port,
			version: this.session?.version,
			url: this.page?.url(),
			mode: this.launchedHeadless === void 0 ? void 0 : this.launchedHeadless ? "headless" : "headful",
			tabs: pages.map((page, index) => ({
				index,
				url: page.url(),
				active: page === this.page
			})),
			error: this.reason
		};
	}
	/**
	* Observe status changes.
	* @param listener - called on every change, not on subscription.
	* @returns unsubscribe callback.
	*/
	watch(listener) {
		this.watchers.add(listener);
		return () => {
			this.watchers.delete(listener);
		};
	}
	/** Whether anyone is watching this browser's frames. */
	hasViewers() {
		return this.viewers.size > 0;
	}
	/**
	* Start the browser if it is not running, joining an in-flight start.
	*
	* A browser that died or failed is started again here, which is what makes
	* any later request — a tool call, a viewer reconnecting, the pane's restart
	* — recover without reloading the plugin.
	* @returns after the browser is ready.
	* @throws {Error} when the browser cannot start.
	*/
	async ensure() {
		if (this.state === "ready") return;
		if (this.starting !== void 0) {
			await this.starting;
			return;
		}
		this.starting = this.start();
		try {
			await this.starting;
		} finally {
			this.starting = void 0;
		}
	}
	/**
	* Subscribe a viewer. The first subscriber starts the stream, the last one
	* leaving stops it.
	* @param listener - receives every frame while subscribed.
	* @returns unsubscribe callback.
	*/
	addViewer(listener) {
		this.viewers.add(listener);
		if (this.viewers.size === 1) this.openStreamForViewers();
		return () => {
			this.viewers.delete(listener);
			if (this.viewers.size === 0) this.closeStream();
		};
	}
	/**
	* Open an address in the active page.
	* @param url - absolute address to load.
	* @returns the address actually landed on.
	*/
	async navigate(url) {
		await this.ensure();
		const page = this.requirePage();
		this.viewport = void 0;
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 3e4
		});
		this.publish();
		return page.url();
	}
	/** Reload the active page. */
	async reload() {
		await this.ensure();
		this.viewport = void 0;
		await this.requirePage().reload({
			waitUntil: "domcontentloaded",
			timeout: 3e4
		});
		this.publish();
	}
	/**
	* Replace the browser with a freshly started one.
	*
	* This is what a viewer asks for when the browser it was watching is gone or
	* unusable: the session keeps its browser slot, the process is new, and the
	* pages of the old one are not carried over.
	* @throws {Error} when the new browser cannot start.
	*/
	async restart() {
		await this.close();
		await this.ensure();
	}
	/**
	* Capture the active page.
	* @returns the encoded image and the page size it was taken at.
	*/
	async screenshot() {
		await this.ensure();
		const cdp = this.cdpSession();
		const captured = await cdp.send("Page.captureScreenshot", {
			format: "jpeg",
			quality: this.config.quality
		});
		const metrics = await cdp.send("Page.getLayoutMetrics");
		return {
			jpeg: Buffer.from(captured.data, "base64"),
			width: metrics.cssVisualViewport?.clientWidth ?? 0,
			height: metrics.cssVisualViewport?.clientHeight ?? 0
		};
	}
	/**
	* Evaluate an expression in the active page and return its value.
	* @param expression - JavaScript source evaluated as an expression.
	* @returns the value, decoded when it is JSON-representable.
	* @throws {Error} when the page throws or the value cannot be decoded.
	*/
	async evaluate(expression) {
		await this.ensure();
		return await this.evaluateIn(this.cdpSession(), expression);
	}
	/**
	* Read the active page as an accessibility tree.
	*
	* The refs it returns replace whatever the last snapshot handed out: a ref
	* names a DOM node, and a page that changed may have moved or removed it.
	* @returns the tree as text, with the refs it used.
	*/
	async snapshot() {
		await this.ensure();
		const snapshot = formatAxTree((await this.cdpSession().send("Accessibility.getFullAXTree")).nodes ?? [], { maxNodes: this.config.snapshotNodes });
		this.refs = snapshot.refs;
		return snapshot;
	}
	/**
	* Click the element a ref names, with real mouse events.
	*
	* The events are dispatched through the same input channel a viewer's clicks
	* use, which is what makes them trusted: a site that ignores a synthetic
	* `element.click()` accepts these.
	* @param ref - a ref from the latest snapshot.
	* @throws {Error} when the ref is unknown, or the element has nothing to click.
	*/
	async click(ref) {
		await this.ensure();
		const cdp = this.cdpSession();
		const { x, y } = await this.pointOf(cdp, ref);
		await dispatchInput(cdp, {
			type: "mouse",
			action: "move",
			x,
			y
		});
		await dispatchInput(cdp, {
			type: "mouse",
			action: "down",
			x,
			y
		});
		await dispatchInput(cdp, {
			type: "mouse",
			action: "up",
			x,
			y
		});
	}
	/**
	* Type into the element a ref names.
	*
	* Text arrives through `Input.insertText`, so it is inserted as characters
	* rather than replayed as keystrokes — which is what makes non-Latin input
	* work. A key is pressed afterwards for fields whose meaning is the Enter
	* that follows.
	* @param ref - a ref from the latest snapshot.
	* @param value - the text to insert.
	* @param options - whether to replace the current content, and a key to press after.
	* @throws {Error} when the ref is unknown.
	*/
	async type(ref, value, options = {}) {
		await this.ensure();
		const cdp = this.cdpSession();
		const backendNodeId = this.nodeFor(ref);
		await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
		await cdp.send("DOM.focus", { backendNodeId });
		if (options.clear !== false) await this.evaluateIn(cdp, "globalThis.document.activeElement?.select?.()").catch(() => {});
		if (value !== "") await dispatchInput(cdp, {
			type: "text",
			text: value
		});
		if (options.key !== void 0) await dispatchInput(cdp, {
			type: "key",
			key: options.key
		});
	}
	/**
	* Where a ref's element is, in the coordinates CDP dispatches input in.
	* @param cdp - session attached to the active page.
	* @param ref - a ref from the latest snapshot.
	* @returns the centre of the element's first content quad, in viewport pixels.
	* @throws {Error} when the ref is unknown or the element is not rendered.
	*/
	async pointOf(cdp, ref) {
		const backendNodeId = this.nodeFor(ref);
		await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
		const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId });
		const quad = quads?.[0];
		if (quad === void 0) throw new Error(`dsh-browser: ${ref} has no visible box in the page; take a new snapshot and try again`);
		const metrics = await cdp.send("Page.getLayoutMetrics");
		const centre = centerOfQuad(quad);
		return {
			x: centre.x - (metrics.cssLayoutViewport?.pageX ?? 0),
			y: centre.y - (metrics.cssLayoutViewport?.pageY ?? 0)
		};
	}
	/**
	* The DOM node a ref names.
	* @param ref - a ref from the latest snapshot.
	* @returns the backend node id.
	* @throws {Error} when no snapshot on this page handed out that ref.
	*/
	nodeFor(ref) {
		const backendNodeId = this.refs.get(ref);
		if (backendNodeId === void 0) throw new Error(`dsh-browser: ${ref} is not a ref from a snapshot of the current page; call browser_snapshot and use a ref from its result`);
		return backendNodeId;
	}
	/**
	* Evaluate an expression over one CDP session.
	* @param cdp - session to evaluate on.
	* @param expression - JavaScript source evaluated as an expression.
	* @returns the value, decoded when it is JSON-representable.
	* @throws {Error} when the page throws.
	*/
	async evaluateIn(cdp, expression) {
		const outcome = await cdp.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true
		});
		if (outcome.exceptionDetails !== void 0) {
			const detail = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? "evaluation failed";
			throw new Error(detail);
		}
		return outcome.result?.value ?? outcome.result?.unserializableValue;
	}
	/**
	* Apply viewer input to the active page.
	* @param message - the decoded viewer message.
	*/
	async input(message) {
		await this.ensure();
		const cdp = this.cdpSession();
		await dispatchInput(cdp, scaleToViewport(message, await this.viewportSize(cdp)));
	}
	/**
	* The page's CSS viewport, cached briefly so a pointer move is not a round trip.
	* @param cdp - session attached to the active page.
	* @returns the viewport in CSS pixels.
	*/
	async viewportSize(cdp) {
		const now = Date.now();
		if (this.viewport !== void 0 && now - this.viewport.at < VIEWPORT_TTL_MS) return this.viewport.size;
		const metrics = await cdp.send("Page.getLayoutMetrics");
		const size = {
			width: metrics.cssVisualViewport?.clientWidth ?? 0,
			height: metrics.cssVisualViewport?.clientHeight ?? 0
		};
		this.viewport = {
			at: now,
			size
		};
		return size;
	}
	/** Stop the browser and release its port and temporary profile. */
	async close() {
		this.closing = true;
		try {
			await this.closeStream();
			const session = this.session;
			this.session = void 0;
			this.page = void 0;
			this.cdp = void 0;
			this.launchedHeadless = void 0;
			this.reason = void 0;
			this.setState("closed");
			if (session !== void 0) await session.context.close().catch(() => {});
		} finally {
			this.closing = false;
		}
		this.releasePort();
		await this.removeTemporaryProfile();
	}
	/** Start the browser, attach to its first page, and open the startup address. */
	async start() {
		this.setState("starting");
		try {
			this.port = await this.ports.allocate();
			const userDataDir = this.config.userDataDir === "" ? await mkdtemp(join(tmpdir(), "dsh-browser-")) : profileDirFor(this.config.userDataDir, this.sessionId);
			if (this.config.userDataDir === "") this.temporaryProfile = userDataDir;
			const session = await this.launch({
				...this.config,
				debugPort: this.port
			}, userDataDir);
			this.session = session;
			this.launchedHeadless = this.config.headless;
			this.observe(session.context);
			const page = session.context.pages()[0] ?? await session.context.newPage();
			await this.adopt(page);
			if (this.config.startupUrl !== "" && this.config.startupUrl !== "about:blank") await page.goto(this.config.startupUrl, {
				waitUntil: "domcontentloaded",
				timeout: 3e4
			});
			this.reason = void 0;
			this.setState("ready");
			this.logger.info(`dsh-browser: session ${this.sessionId} is on ${await page.title().catch(() => "") || page.url()} — CDP on 127.0.0.1:${String(this.port)} (${session.version})`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			await this.close();
			this.reason = reason;
			this.setState("failed");
			throw error;
		}
	}
	/**
	* Follow the browser's own lifecycle: a context that closes without being
	* asked to, and pages it opens on its own.
	*
	* The mirror follows the newest page, which is what a person would see: a
	* link that opens a tab puts that tab in front, and the tools act on what is
	* in front rather than on a page that scrolled away behind it.
	* @param context - the launched browser's context.
	*/
	observe(context) {
		context.on("close", () => {
			if (this.closing) return;
			this.logger.warn(/* @__PURE__ */ new Error(`dsh-browser: session ${this.sessionId} lost its browser: ${DIED_REASON}`));
			this.forget();
			this.reason = DIED_REASON;
			this.setState("closed");
		});
		context.on("page", (page) => {
			this.logger.info(`dsh-browser: session ${this.sessionId} opened a new tab`);
			this.adopt(page).catch((error) => {
				this.logger.warn(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}
	/**
	* Make one page the page tools and the mirror act on.
	*
	* A page carries its own CDP session, so following one means attaching to it
	* and restarting the mirror from the new attachment; the old attachment is
	* detached afterwards, once nothing is reading it.
	* @param page - the page to adopt.
	*/
	async adopt(page) {
		const previous = this.cdp;
		this.page = page;
		this.refs = /* @__PURE__ */ new Map();
		page.on("framenavigated", () => {
			this.refs = /* @__PURE__ */ new Map();
			this.publish();
		});
		page.on("close", () => {
			if (this.page !== page) {
				this.publish();
				return;
			}
			this.moveToSurvivingPage();
		});
		const cdp = await this.session?.context.newCDPSession(page);
		if (cdp === void 0) return;
		this.viewport = void 0;
		this.cdp = cdp;
		if (this.config.stealth) await hideHeadlessUserAgent(cdp, page);
		if (this.stream !== void 0) {
			await this.closeStream();
			await this.openStream();
		}
		if (previous !== void 0 && previous !== cdp) await previous.detach().catch(() => {});
		this.publish();
	}
	/** Move the mirror to a page that still exists after the active one closed. */
	async moveToSurvivingPage() {
		const context = this.session?.context;
		if (context === void 0) return;
		try {
			const survivor = context.pages()[0] ?? await context.newPage();
			await this.adopt(survivor);
		} catch (error) {
			this.logger.warn(error instanceof Error ? error : new Error(String(error)));
		}
	}
	/** Attach the screencast for the current viewers, starting the browser if needed. */
	async openStreamForViewers() {
		try {
			await this.ensure();
		} catch (error) {
			this.logger.warn(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		await this.openStream();
	}
	/** Attach the screencast to the active page's CDP session. */
	async openStream() {
		if (this.viewers.size === 0 || this.stream !== void 0 || this.cdp === void 0) return;
		this.stream = await startScreencast(this.cdp, {
			quality: this.config.quality,
			maxWidth: this.config.maxWidth,
			maxHeight: this.config.maxHeight,
			everyNthFrame: this.config.everyNthFrame
		}, (frame) => {
			for (const viewer of this.viewers) viewer(frame);
		}, (error) => {
			this.logger.warn(error instanceof Error ? error : new Error(String(error)));
		});
	}
	/** Detach the screencast. */
	async closeStream() {
		const stop = this.stream;
		this.stream = void 0;
		if (stop !== void 0) await stop().catch(() => {});
	}
	/** Drop everything the dead browser owned, keeping the viewers subscribed. */
	forget() {
		this.closeStream();
		this.session = void 0;
		this.page = void 0;
		this.cdp = void 0;
		this.launchedHeadless = void 0;
		this.releasePort();
		this.removeTemporaryProfile();
	}
	/** Give the CDP port back, so a later browser may take it. */
	releasePort() {
		if (this.port !== void 0) this.ports.release(this.port);
		this.port = void 0;
	}
	/** Remove a temporary profile; a configured one is the user's to keep. */
	async removeTemporaryProfile() {
		const profile = this.temporaryProfile;
		this.temporaryProfile = void 0;
		if (profile === void 0) return;
		await rm(profile, {
			recursive: true,
			force: true,
			maxRetries: 3
		}).catch(() => {});
	}
	/** The CDP session, or a failure naming the browser state. */
	cdpSession() {
		if (this.cdp === void 0) throw new Error(this.unusable());
		return this.cdp;
	}
	/** The active page, or a failure naming the browser state. */
	requirePage() {
		if (this.page === void 0) throw new Error(this.unusable());
		return this.page;
	}
	/** Why there is nothing to act on, naming the state and its cause. */
	unusable() {
		return `dsh-browser: session ${this.sessionId}'s browser is ${this.state}${this.reason === void 0 ? "" : ` (${this.reason})`}`;
	}
	/** Record a state change and tell the watchers. */
	setState(state) {
		this.state = state;
		this.publish();
	}
	/** Tell the watchers the status moved. */
	publish() {
		const status = this.status();
		for (const watcher of this.watchers) watcher(status);
	}
};
//#endregion
//#region src/browser/pool.ts
/**
* Owns one {@link SessionBrowser} per session.
*/
var BrowserPool = class {
	entries = /* @__PURE__ */ new Map();
	allocator;
	launch;
	logger;
	config;
	/**
	* @param config - resolved plugin configuration.
	* @param logger - where launch outcomes are reported.
	* @param launch - starts a browser; replaced in tests.
	* @param probe - port availability test; replaced in tests.
	*/
	constructor(config, logger, launch = launchBrowser, probe) {
		this.config = config;
		this.logger = logger;
		this.launch = launch;
		this.allocator = new PortAllocator(config.debugPort, [], probe);
	}
	/** How many browsers exist. */
	get size() {
		return this.entries.size;
	}
	/**
	* The browser belonging to a session, creating it if this is the first use.
	* @param sessionId - the session whose browser is wanted.
	* @returns the session's browser, not yet started.
	* @throws {Error} when the session id cannot name a profile directory, or when
	* the instance limit is already reached.
	*/
	get(sessionId) {
		if (sessionId === "") throw new Error("dsh-browser: a browser cannot belong to an empty session id");
		const existing = this.entries.get(sessionId);
		if (existing !== void 0) return existing;
		if (this.entries.size >= this.config.maxInstances) throw new Error(`dsh-browser: ${String(this.config.maxInstances)} session browsers are already running (maxInstances); close one from its Sidebar tab, or raise maxInstances`);
		const created = new SessionBrowser(sessionId, {
			config: this.config,
			ports: this.allocator,
			launch: this.launch,
			logger: this.logger
		});
		this.entries.set(sessionId, created);
		return created;
	}
	/**
	* The browser belonging to a session, without creating one.
	* @param sessionId - the session whose browser is wanted.
	* @returns the browser, or `undefined` when this session has none.
	*/
	peek(sessionId) {
		return this.entries.get(sessionId);
	}
	/** Everything running, for the settings page and diagnostics. */
	status() {
		return {
			maxInstances: this.config.maxInstances,
			instances: [...this.entries.values()].map((instance) => instance.status())
		};
	}
	/**
	* Adopt a new configuration, for the browsers that already exist and for
	* every one created afterwards.
	* @param next - the newly resolved configuration.
	* @returns after every live browser has been restarted, where one had to be.
	*/
	async reconfigure(next) {
		this.config = next;
		this.allocator.setBase(next.debugPort);
		await Promise.all([...this.entries.values()].map(async (instance) => {
			await instance.reconfigure(next);
		}));
	}
	/**
	* Close one session's browser and forget it.
	*
	* Its port and temporary profile are released with it, so the next session to
	* start may reuse them.
	* @param sessionId - the session whose browser is going away.
	*/
	async dispose(sessionId) {
		const instance = this.entries.get(sessionId);
		if (instance === void 0) return;
		this.entries.delete(sessionId);
		await instance.close();
	}
	/** Close every browser, for plugin unload. */
	async closeAll() {
		const instances = [...this.entries.values()];
		this.entries.clear();
		await Promise.all(instances.map(async (instance) => {
			await instance.close();
		}));
	}
};
//#endregion
//#region src/view/server.ts
/** Path the Sidebar viewer connects to, with the session it watches as a query parameter. */
const STREAM_PATH = "/dsh-browser/stream";
/** Query parameter naming the session whose browser the viewer wants. */
const SESSION_PARAM = "session";
/**
* The session a viewer named.
* @param request - the upgrade request.
* @returns the session id, or `undefined` when it named none.
*/
function sessionOf(request) {
	const named = new URL(request.url ?? "/", "http://localhost").searchParams.get(SESSION_PARAM);
	return named === null || named === "" ? void 0 : named;
}
/**
* Register the viewer route for the plugin's lifetime.
* @param ctx - plugin context carrying `webServer` and `connection`.
* @param pool - the browsers the route mirrors and drives.
*/
function registerStream(ctx, pool) {
	ctx.inject(["webServer", "connection"], (scoped) => {
		const server = new WebSocketServer({ noServer: true });
		scoped.effect(() => {
			const unregister = scoped.webServer.registerUpgrade({
				path: STREAM_PATH,
				handler: (request, socket, head) => {
					const rejection = scoped.connection.requestRejection(request);
					if (rejection !== void 0) {
						socket.write(`HTTP/1.1 ${rejection} ${rejection === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r
Content-Length: 0\r
\r
`);
						socket.destroy();
						return;
					}
					const sessionId = sessionOf(request);
					if (sessionId === void 0) {
						socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
						socket.destroy();
						return;
					}
					server.handleUpgrade(request, socket, head, (client) => {
						attach(client, pool, sessionId);
					});
				}
			});
			return () => {
				unregister();
				server.close();
			};
		}, "dsh-browser: viewer stream");
	});
}
/**
* Serve one viewer for its connection's lifetime.
* @param client - the accepted socket.
* @param pool - the browsers a session's viewer can address.
* @param sessionId - the session this viewer named.
*/
function attach(client, pool, sessionId) {
	const send = (value) => {
		if (client.readyState === client.OPEN) client.send(JSON.stringify(value));
	};
	let browser;
	try {
		browser = pool.get(sessionId);
	} catch (error) {
		send({
			type: "error",
			message: error instanceof Error ? error.message : String(error)
		});
		client.close();
		return;
	}
	const stopFrames = browser.addViewer((frame) => {
		if (client.readyState === client.OPEN) client.send(frame.jpeg, { binary: true });
	});
	const stopStatus = browser.watch((status) => {
		send({
			type: "status",
			status
		});
	});
	send({
		type: "status",
		status: browser.status()
	});
	client.on("message", (raw, isBinary) => {
		if (isBinary) return;
		handleMessage(String(raw), browser).catch((error) => {
			send({
				type: "error",
				message: error instanceof Error ? error.message : String(error)
			});
		});
	});
	const release = () => {
		stopStatus();
		stopFrames();
	};
	client.on("close", release);
	client.on("error", release);
}
/**
* Apply one viewer message.
* @param raw - the received text frame.
* @param browser - the session's browser to act on.
* @throws {Error} when the message is malformed or names an unknown verb.
*/
async function handleMessage(raw, browser) {
	const parsed = JSON.parse(raw);
	switch (parsed.type) {
		case "input":
			await browser.input(parsed.message);
			return;
		case "navigate":
			await browser.navigate(String(parsed.url));
			return;
		case "reload":
			await browser.reload();
			return;
		case "restart":
			await browser.restart();
			return;
		case "close":
			await browser.close();
			return;
		default: throw new Error(`dsh-browser: unknown viewer message ${JSON.stringify(parsed.type)}`);
	}
}
//#endregion
//#region src/view/status.ts
/** Path the settings page reads the live browser state from. */
const STATUS_PATH = "/dsh-browser/status";
/**
* Register the status route for the plugin's lifetime.
* @param ctx - plugin context carrying `webServer` and `connection`.
* @param pool - the browsers whose state is reported.
*/
function registerStatus(ctx, pool) {
	ctx.inject(["webServer", "connection"], (scoped) => {
		scoped.effect(() => scoped.webServer.register({
			kind: "exact",
			path: STATUS_PATH,
			handler: (request, response) => {
				const rejection = scoped.connection.requestRejection(request);
				if (rejection !== void 0) {
					response.writeHead(rejection, { "Content-Type": "text/plain" });
					response.end(rejection === 401 ? "Unauthorized" : "Forbidden");
					return;
				}
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				});
				response.end(JSON.stringify(pool.status()));
			}
		}), "dsh-browser: status route");
	});
}
//#endregion
//#region src/tools/index.ts
/**
* The agent-facing half of the mirror: six tools over the browser belonging to
* the calling conversation.
*
* The set is deliberately small and leans on `browser_evaluate` for everything
* a short piece of JavaScript expresses better than a parameter list — reading
* values, scrolling, waiting, going back. What is here is what code cannot do
* or does badly: a real click (a synthetic `element.click()` is not a trusted
* event and some sites ignore it), typing that produces input events, reading a
* page without knowing its selectors first, and a picture.
*
* A tool addresses the browser of the session that called it, taken from the
* execution's agent, so two conversations never touch each other's pages. A
* call with no session — a scheduled job, or a subagent without one — fails
* rather than landing in somebody's browser.
*
* Tools return text and file paths rather than image blocks. An image block
* carries an attachment reference owned by the attachment service, which a
* plugin cannot mint for itself, and the shipped adapters declare text-only
* output besides: a screenshot lands on disk and the model reads it back with
* its ordinary file tools, which also makes the capture durable in the session
* log.
*/
/** Directory screenshots are written to; inside the OS temp area, so it needs no cleanup contract. */
const SHOT_DIR = join(tmpdir(), "dsh-browser-shots");
/**
* Render one evaluated value as text for the model.
* @param value - the value the page produced.
* @returns JSON when the value survives encoding, its string form otherwise.
*/
function readable(value) {
	if (value === void 0) return "undefined";
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
/**
* The open pages, one line each.
*
* A tool result carries this because the pages are not the caller's to choose:
* a link that opens a tab moves the active page, and a caller that could not
* see that would keep describing the page it left behind.
* @param tabs - the session's open pages.
* @returns one line per page, naming the active one.
*/
function tabsText(tabs) {
	if (tabs.length === 0) return "No pages are open.";
	return tabs.map((tab) => `[${tab.active ? "active" : String(tab.index)}] ${tab.url}`).join("\n");
}
/** The reported shape of the page list every navigation-shaped result carries. */
const TABS_SCHEMA = {
	type: "array",
	required: true,
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			index: {
				type: "integer",
				required: true
			},
			url: {
				type: "string",
				required: true
			},
			active: {
				type: "boolean",
				required: true
			}
		}
	}
};
/**
* The browser belonging to the calling session.
* @param pool - every session's browser.
* @param exec - the execution the call runs in.
* @returns the caller's browser, not yet started.
* @throws {Error} when the call has no session to attribute a browser to.
*/
function browserFor(pool, exec) {
	const sessionId = exec.agent?.id;
	if (sessionId === void 0) throw new Error("dsh-browser: this tool drives the browser of the conversation it was called from, and this call has no session");
	return pool.get(sessionId);
}
/**
* Register the browser tools for the plugin's lifetime.
* @param ctx - plugin context carrying the tool registry.
* @param pool - the browsers the tools drive.
*/
function registerTools(ctx, pool) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_navigate",
		description: "Open an address in this conversation's local browser. The same browser is mirrored in the Sidebar, so the user sees the page the call lands on.",
		parameters: { url: {
			type: "string",
			required: true,
			description: "Absolute http(s) address to open."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.title}\n${value.url}\n\n${tabsText(value.tabs)}`
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			const url = await browser.navigate(args.url);
			const title = await browser.evaluate("document.title");
			return {
				url,
				title: typeof title === "string" ? title : "",
				tabs: [...browser.status().tabs]
			};
		}
	})), "dsh-browser: browser_navigate");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_snapshot",
		description: "Read the current page as a tree of roles, names, and refs. Refs name elements for browser_click and browser_type, and belong to this snapshot: take a new one after the page changes.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.text}\n\n${tabsText(value.tabs)}`
			}]
		},
		async execute(_args, exec) {
			const browser = browserFor(pool, exec);
			const snapshot = await browser.snapshot();
			return {
				text: snapshot.text,
				truncated: snapshot.truncated,
				tabs: [...browser.status().tabs]
			};
		}
	})), "dsh-browser: browser_snapshot");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click an element named by a ref from browser_snapshot, with real mouse events at the element's own position.",
		parameters: { ref: {
			type: "string",
			required: true,
			description: "Ref from the latest browser_snapshot, such as e3."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ref: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Clicked ${value.ref}. The active page is now ${value.url}`
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			await browser.click(args.ref);
			return {
				ref: args.ref,
				url: browser.status().url ?? ""
			};
		}
	})), "dsh-browser: browser_click");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Type text into an element named by a ref from browser_snapshot, replacing what the field holds. Pass a key such as Enter to submit after typing.",
		parameters: {
			ref: {
				type: "string",
				required: true,
				description: "Ref from the latest browser_snapshot, such as e3."
			},
			text: {
				type: "string",
				required: true,
				description: "Text to insert; non-Latin text is inserted as characters, not keystrokes."
			},
			key: {
				type: "string",
				description: "Key to press after typing, such as Enter or Tab."
			},
			clear: {
				type: "boolean",
				description: "Whether to replace the field's current content first; defaults to true."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ref: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Typed ${JSON.stringify(value.text)} into ${value.ref}.`
			}]
		},
		async execute(args, exec) {
			await browserFor(pool, exec).type(args.ref, args.text, {
				...args.clear === void 0 ? {} : { clear: args.clear },
				...args.key === void 0 ? {} : { key: args.key }
			});
			return {
				ref: args.ref,
				text: args.text
			};
		}
	})), "dsh-browser: browser_type");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_screenshot",
		description: "Capture this conversation's browser page to a JPEG file and return its path. Read that file to look at the page.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					width: {
						type: "integer",
						required: true
					},
					height: {
						type: "integer",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Captured ${value.width}x${value.height} to ${value.path} (${value.bytes} bytes).`
			}]
		},
		async execute(_args, exec) {
			const shot = await browserFor(pool, exec).screenshot();
			await mkdir(SHOT_DIR, { recursive: true });
			const path = join(SHOT_DIR, `shot-${Date.now()}.jpg`);
			await writeFile(path, shot.jpeg);
			return {
				path,
				width: shot.width,
				height: shot.height,
				bytes: shot.jpeg.length
			};
		}
	})), "dsh-browser: browser_screenshot");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_evaluate",
		description: "Evaluate a JavaScript expression in this conversation's browser page and return its value. The general-purpose tool: use it to read values, scroll, wait for something, or go back in history.",
		parameters: { expression: {
			type: "string",
			required: true,
			description: "Expression evaluated in the page; awaited when it returns a promise."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { result: {
					type: "string",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.result
			}]
		},
		async execute(args, exec) {
			return { result: readable(await browserFor(pool, exec).evaluate(args.expression)) };
		}
	})), "dsh-browser: browser_evaluate");
}
//#endregion
//#region src/config.ts
/**
* Plugin configuration, changeable from cordis.yml.
*
* Every field is a deployment choice rather than a protocol constant: which
* installed browser to drive, whether it gets a window, where its profile
* lives, and how much bandwidth the mirror spends. Empty strings mean "not
* set" so the schema stays free of optionality.
*/
/** Schema for {@link BrowserConfig}. */
const Config = z.object({
	channel: z.union([z.const("chrome"), z.const("msedge")]).default("chrome"),
	executablePath: z.string().default(""),
	headless: z.boolean().default(true),
	userDataDir: z.string().default(""),
	debugPort: z.natural().max(65535).default(9333),
	viewportWidth: z.natural().default(1440),
	viewportHeight: z.natural().default(900),
	stealth: z.boolean().default(true),
	startupUrl: z.string().default("about:blank"),
	quality: z.natural().min(1).max(100).default(70),
	maxWidth: z.natural().default(1600),
	maxHeight: z.natural().default(1200),
	everyNthFrame: z.natural().default(1),
	snapshotNodes: z.natural().min(1).default(300),
	maxInstances: z.natural().min(1).max(16).default(4),
	extraArgs: z.array(z.string()).default([])
});
//#endregion
//#region src/settings.ts
/** The settings namespace this plugin owns. */
const SETTINGS_NAMESPACE = "dsh-browser";
/**
* Register the settings namespace and follow it.
* @param ctx - plugin context.
* @param entry - the composition entry config, used as the base layer.
* @param pool - the browsers that are reconfigured on every change.
*/
function installSettings(ctx, entry, pool) {
	ctx.inject(["settings"], (scoped) => {
		let current = () => entry;
		scoped.settings.installSection(scoped, SETTINGS_NAMESPACE, Config, entry, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				pool.reconfigure(current());
			}
		});
	});
}
//#endregion
//#region src/index.ts
/** Plugin identity in cordis diagnostics. */
const name = "dsh-browser";
/**
* Services this plugin cannot work without.
*
* `connection` is a hard requirement, not an optional one: the viewer route is
* served by this plugin and would be unauthenticated without it, so a profile
* that cannot supply the trust check must fail to load the plugin rather than
* run an open route into the user's browser.
*/
const inject = [
	"tools",
	"webServer",
	"connection"
];
/**
* Host half: own the browsers, serve the mirror, and register the tools.
* @param ctx - plugin context.
* @param config - resolved plugin configuration.
*/
function apply(ctx, config) {
	const pool = new BrowserPool(config, ctx.logger);
	ctx.effect(() => () => {
		pool.closeAll();
	}, "dsh-browser: browser lifetime");
	ctx.on("session/disposed", (session) => {
		pool.dispose(session.id);
	});
	installSettings(ctx, config, pool);
	registerStream(ctx, pool);
	registerStatus(ctx, pool);
	registerTools(ctx, pool);
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map