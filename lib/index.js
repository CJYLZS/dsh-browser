import { chromium } from "playwright-core";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { WebSocketServer } from "ws";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
* @param config - resolved plugin configuration, with the port to listen on.
* @param userDataDir - profile directory to open (temporary or configured).
* @param timeoutMs - budget for the browser to start and for its listener to answer.
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
		timeout: timeoutMs,
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
//#endregion
//#region src/browser/ports.ts
/**
* Hand out one external CDP port per browser.
*
* The configuration names a *window* of ports rather than an address: every
* session gets its own browser, every browser needs its own port, and the first
* session's browser takes the lowest free port in the window while the next one
* takes the next. Probing binds the port and releases it, which is the only way
* to ask the operating system — and because the answer is stale the moment it is
* given, an allocator also *holds* each port it hands out until its browser is
* gone.
*
* The window is bounded on purpose. A browser that cannot listen inside it is a
* failure worth reporting, and the message names the window so a deployment can
* widen it — walking past the top would collide with whatever else this machine
* runs, which is exactly what the end is there to prevent.
*/
/**
* Read a window from its two configured ends.
*
* The ends are sorted rather than validated: a deployment that fills the two
* boxes the other way round means the same window, and refusing to start a
* browser over it would be a worse answer than using it.
* @param first - one end of the window.
* @param second - the other end.
* @returns the window, lowest end first.
*/
function portWindow(first, second) {
	return first <= second ? {
		low: first,
		high: second
	} : {
		low: second,
		high: first
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
	range;
	probe;
	/**
	* @param range - the window to search.
	* @param taken - ports known to be in use already.
	* @param probe - availability test, replaced in tests.
	*/
	constructor(range, taken = [], probe = canBind) {
		this.range = range;
		this.held = new Set(taken);
		this.probe = probe;
	}
	/**
	* Take the lowest free port.
	* @returns the port, held for this allocator until {@link release}.
	* @throws {Error} when nothing in the window is free.
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
	* Move the window, after the configured range changed.
	*
	* Ports already held stay held: the browsers listening on them are still
	* running, whatever the configuration now says, and they come back only when
	* those browsers close.
	* @param range - the newly configured window.
	*/
	setWindow(range) {
		this.range = range;
	}
	/** The window currently searched. */
	get window() {
		return this.range;
	}
	/** Ports currently held, for diagnostics. */
	get heldPorts() {
		return [...this.held];
	}
	/** Probe the window from its lowest end upwards. */
	async search() {
		for (let port = this.range.low; port <= this.range.high && port <= 65535; port++) {
			if (this.held.has(port)) continue;
			if (!await this.probe(port)) continue;
			this.held.add(port);
			return port;
		}
		throw new Error(`dsh-browser: no free CDP port in ${this.range.low}-${this.range.high}; another process holds them, or the window is narrower than the number of session browsers`);
	}
};
/**
* Properties worth printing unless the caller says otherwise.
*
* Deliberately short: `focusable`, `editable`, and `multiline` describe how the
* tree was built rather than what the page says, and a line is only worth
* printing if it tells the model something it could not act on anyway.
*/
const DEFAULT_ATTRIBUTES = [
	"url",
	"level",
	"placeholder",
	"valuetext",
	"roledescription",
	"keyshortcuts",
	"orientation",
	"haspopup",
	"description"
];
/** States worth printing, in the order they appear on a line. */
const STATES = [
	"checked",
	"disabled",
	"expanded",
	"selected",
	"required",
	"pressed"
];
/** Roles that are pure text: a rendering detail, never something to act on. */
const TEXT_ROLES = /* @__PURE__ */ new Set([
	"InlineTextBox",
	"LineBreak",
	"ListMarker"
]);
/** Roles that describe nesting rather than content, when they have no name. */
const STRUCTURAL_ROLES = /* @__PURE__ */ new Set([
	"none",
	"generic",
	"paragraph",
	"listitem",
	"article",
	"list",
	"group",
	"section"
]);
/** Longest property value printed before it is cut, in characters. */
const ATTRIBUTE_MAX = 60;
/** Render one value for display inside quotes. */
function quoted(value) {
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
/** Read a CDP value field, which is `unknown` because the protocol allows any type. */
function text(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
/** A node's role, with a placeholder for the nodes that report none. */
function roleOf(node) {
	return text(node.role?.value) || "node";
}
/** A node's accessible name. */
function nameOf(node) {
	return text(node.name?.value);
}
/**
* Join two text runs the way a reader would.
*
* Runs are separate DOM nodes only because the page marked them up that way;
* `Hello ` and `bold` are one sentence, while `$` and `12` are one amount. A
* space appears only where neither side brought one, and never before
* punctuation that would not take one.
* @param left - the text so far.
* @param right - the run being added.
* @returns the joined text.
*/
function joinRuns(left, right) {
	if (left === "") return right;
	if (right === "") return left;
	return /[\s(\u2014-]$/u.test(left) || /^[\s.,;:!?)\u2014-]/u.test(right) ? left + right : `${left} ${right}`;
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
/** Whether a node reports a state worth keeping it for. */
function hasStates(node) {
	return statesOf(node) !== "";
}
/** The properties the whitelist asked for, in the whitelist's order. */
function attributesOf(node, whitelist) {
	if (whitelist.length === 0) return [];
	const reported = /* @__PURE__ */ new Map();
	for (const property of node.properties ?? []) {
		if (property.name === void 0) continue;
		reported.set(property.name, text(property.value?.value));
	}
	const rendered = [];
	for (const name of whitelist) {
		if (STATES.includes(name)) continue;
		const value = name === "description" ? text(node.description?.value) : reported.get(name);
		if (value === void 0 || value === "") continue;
		rendered.push([name, value.length > ATTRIBUTE_MAX ? `${value.slice(0, ATTRIBUTE_MAX)}…` : value]);
	}
	return rendered;
}
/** One node rendered as its own line, without indentation. */
function lineOf(node, ref, whitelist, fresh) {
	const name = nameOf(node);
	const value = text(node.value?.value);
	let line = `- ${roleOf(node)}`;
	if (name !== "") line += ` ${quoted(name)}`;
	if (value !== "") line += ` value=${quoted(value)}`;
	const said = new Set([name, value].filter((entry) => entry !== ""));
	for (const [key, attributeValue] of attributesOf(node, whitelist)) {
		if (said.has(attributeValue)) continue;
		said.add(attributeValue);
		line += ` ${key}=${quoted(attributeValue)}`;
	}
	line += statesOf(node);
	if (ref !== void 0) line += ` ${fresh ? "*" : ""}[ref=${ref}]`;
	return line;
}
/**
* The refs one page hands out.
*
* Labels are stable for as long as the page is loaded: a node that already has
* one keeps it however much appears above it, which is what makes a ref worth
* remembering and what stops a new snapshot from invalidating the refs of the
* last one. The role and name are kept beside the label so an action can look
* for the element again after the DOM replaced it.
*
* Numbering runs across the pages one browser shows, not per page. A page that
* goes away has its labels forgotten, but the next page starts counting where
* it stopped, because a ref a caller kept is only a string: if the new page
* minted `e1` again, that string would name one element on the new page and had
* named another on the old one, and nothing could tell the two apart.
*/
var RefLabels = class {
	byNode = /* @__PURE__ */ new Map();
	byLabel = /* @__PURE__ */ new Map();
	next = 1;
	/** Every DOM node the page held at the last snapshot, for deciding novelty. */
	present;
	/**
	* The label for one DOM node, minting one the first time it is asked for.
	* @param backendNodeId - the DOM node behind the line.
	* @param role - the role the node reports now.
	* @param name - the accessible name the node reports now.
	* @returns the label, and whether the page gained this node since the last
	* snapshot — a node a depth limit or a budget kept out of the text was there
	* all along, and calling that new would send a model looking for a change it
	* made itself by asking for more of the page.
	*/
	labelFor(backendNodeId, role, name) {
		const existing = this.byNode.get(backendNodeId);
		if (existing !== void 0) {
			existing.role = role;
			existing.name = name;
			return {
				label: existing.label,
				fresh: false
			};
		}
		const label = `e${String(this.next)}`;
		this.next += 1;
		this.byNode.set(backendNodeId, {
			label,
			role,
			name
		});
		this.byLabel.set(label, backendNodeId);
		return {
			label,
			fresh: this.present !== void 0 && !this.present.has(backendNodeId)
		};
	}
	/**
	* What a label names.
	* @param label - a ref label.
	* @returns the DOM node and its recorded semantics, or `undefined`.
	*/
	targetOf(label) {
		const backendNodeId = this.byLabel.get(label);
		if (backendNodeId === void 0) return void 0;
		const entry = this.byNode.get(backendNodeId);
		if (entry === void 0) return void 0;
		return {
			backendNodeId,
			role: entry.role,
			name: entry.name
		};
	}
	/**
	* Point a label at the node that now stands for it.
	* @param label - the label to re-point.
	* @param target - the node that replaced the one the label named.
	*/
	rebind(label, target) {
		const previous = this.byLabel.get(label);
		if (previous !== void 0) this.byNode.delete(previous);
		for (const [backendNodeId, entry] of this.byNode) if (backendNodeId === target.backendNodeId) this.byLabel.delete(entry.label);
		this.byNode.set(target.backendNodeId, {
			label,
			role: target.role,
			name: target.name
		});
		this.byLabel.set(label, target.backendNodeId);
	}
	/** Every label this page has handed out. */
	entries() {
		const entries = /* @__PURE__ */ new Map();
		for (const [backendNodeId, entry] of this.byNode) entries.set(entry.label, backendNodeId);
		return entries;
	}
	/** How many labels this page has handed out. */
	get size() {
		return this.byNode.size;
	}
	/**
	* Forget a page that is no longer loaded.
	*
	* The number the next page starts from deliberately carries on from here.
	* Forgetting the labels is what makes a ref from the page before stop working;
	* restarting the count would instead hand that ref to whatever the new page
	* puts in its place, and a caller has no way to tell the difference.
	*/
	forgetPage() {
		this.byNode.clear();
		this.byLabel.clear();
		this.present = void 0;
	}
	/**
	* Record the DOM nodes the page held when a snapshot was taken.
	*
	* Novelty is decided against this rather than against what the last snapshot
	* printed. A depth limit or a budget leaves nodes out of the text without
	* their having appeared since, and a `*` has to mean the page changed.
	* @param present - the DOM nodes the accessibility tree held at the time.
	*/
	observe(present) {
		this.present = new Set(present);
	}
};
/** Whether a node is hidden from assistive technology, children included. */
function hiddenFromAt(node) {
	return (node.ignoredReasons ?? []).some((reason) => reason.name === "ariaHiddenSubtree" || reason.name === "ariaHiddenElement");
}
/**
* The ref target a node makes, when it has a DOM node behind it.
*
* This is the same reading a printed line uses, which is what lets an action
* look for an element again by what the snapshot said about it.
* @param node - one node of the accessibility tree.
* @returns the DOM node and its semantics, or `undefined` for a node with neither.
*/
function refTargetOf(node) {
	if (node.backendDOMNodeId === void 0 || node.ignored === true) return void 0;
	return {
		backendNodeId: node.backendDOMNodeId,
		role: roleOf(node),
		name: nameOf(node)
	};
}
/**
* Print an accessibility tree.
*
* Traversal is depth-first in the tree's own child order. Nodes the filters drop
* are not counted as elided — they were never part of the page as described —
* but nodes the budget or the depth limit left out are, and the text says which
* parameter would have printed them.
* @param nodes - the flat node list CDP returns.
* @param options - budget, depth, target subtree, filters, and label registry.
* @returns the text, the labels it used, and what it left out.
*/
function formatAxTree(nodes, options = {}) {
	const maxNodes = options.maxNodes ?? 500;
	const whitelist = options.attributes ?? DEFAULT_ATTRIBUTES;
	const depthLimit = options.depth;
	const ignore = options.ignore;
	const labels = options.labels ?? new RefLabels();
	const byId = /* @__PURE__ */ new Map();
	const present = /* @__PURE__ */ new Set();
	for (const node of nodes) {
		if (node.nodeId !== void 0) byId.set(node.nodeId, node);
		if (node.backendDOMNodeId !== void 0) present.add(node.backendDOMNodeId);
	}
	const isChild = /* @__PURE__ */ new Set();
	for (const node of nodes) for (const child of node.childIds ?? []) isChild.add(child);
	const roots = nodes.filter((node) => node.nodeId === void 0 || !isChild.has(node.nodeId));
	/** Children of a node, in order, resolved through the flat list. */
	const childrenOf = (node) => {
		const children = [];
		for (const childId of node.childIds ?? []) {
			const child = byId.get(childId);
			if (child !== void 0) children.push(child);
		}
		return children;
	};
	/** Whether this node is dropped with its whole subtree rather than promoted. */
	const dropWholeSubtree = (node) => {
		if (hiddenFromAt(node)) return true;
		return ignore !== void 0 && node.backendDOMNodeId !== void 0 && ignore.has(node.backendDOMNodeId);
	};
	/** Whether a node survives every filter except the grouping rule. */
	const passesFilters = (node, ancestors) => {
		if (node.ignored === true || dropWholeSubtree(node)) return false;
		const role = roleOf(node);
		if (TEXT_ROLES.has(role)) return false;
		const name = nameOf(node);
		const value = text(node.value?.value);
		if (role === "StaticText") return name !== "" && !ancestors.some((ancestor) => ancestor.includes(name));
		if (role === "image" && value === "" && !hasStates(node)) return name !== "" && !ancestors.some((ancestor) => ancestor.includes(name));
		return true;
	};
	const units = /* @__PURE__ */ new Map();
	const printable = /* @__PURE__ */ new Set();
	/** Measure one node's subtree, counting consecutive text runs as one line. */
	const measure = (node, ancestors) => {
		const hidden = dropWholeSubtree(node);
		const name = nameOf(node);
		const childAncestors = name === "" ? ancestors : [...ancestors, name];
		let total = 0;
		if (!hidden) {
			let runOpen = false;
			for (const child of childrenOf(node)) {
				if (roleOf(child) === "StaticText" && passesFilters(child, childAncestors)) {
					printable.add(child);
					if (!runOpen) total += 1;
					runOpen = true;
					continue;
				}
				runOpen = false;
				measure(child, childAncestors);
				total += (printable.has(child) ? 1 : 0) + (units.get(child) ?? 0);
			}
		}
		units.set(node, total);
		if (!hidden && passesFilters(node, ancestors)) {
			if (!(name === "" && text(node.value?.value) === "" && !hasStates(node) && STRUCTURAL_ROLES.has(roleOf(node))) || total > 1) printable.add(node);
		}
	};
	const start = options.target === void 0 ? roots : [targetNode(nodes, options.target)];
	for (const root of start) measure(root, []);
	const lines = [];
	const refs = /* @__PURE__ */ new Map();
	const fresh = /* @__PURE__ */ new Set();
	let nodesPrinted = 0;
	let budgetElided = 0;
	let depthElided = 0;
	/** Print one line for a node, or count it as elided. */
	const emit = (node, depth, below, force = false) => {
		if (!force && !printable.has(node)) return false;
		if (depthLimit !== void 0 && depth > depthLimit) {
			depthElided += 1 + below;
			return false;
		}
		if (nodesPrinted >= maxNodes) {
			budgetElided += 1 + below;
			return false;
		}
		const backendNodeId = node.backendDOMNodeId;
		let ref;
		if (backendNodeId !== void 0 && roleOf(node) !== "StaticText" && !TEXT_ROLES.has(roleOf(node))) {
			const labelled = labels.labelFor(backendNodeId, roleOf(node), nameOf(node));
			ref = labelled.label;
			refs.set(labelled.label, backendNodeId);
			if (labelled.fresh) fresh.add(labelled.label);
		}
		lines.push(`${"  ".repeat(depth)}${lineOf(node, ref, whitelist, ref !== void 0 && fresh.has(ref))}`);
		nodesPrinted += 1;
		return true;
	};
	/** Print the children of a node, promoting the children of the dropped ones. */
	const printChildren = (node, childDepth) => {
		const children = childrenOf(node);
		for (let index = 0; index < children.length; index += 1) {
			const child = children[index];
			if (child === void 0) continue;
			if (!printable.has(child)) {
				if (!dropWholeSubtree(child)) printChildren(child, childDepth);
				continue;
			}
			if (roleOf(child) === "StaticText") {
				let merged = nameOf(child);
				let next = index + 1;
				while (next < children.length) {
					const following = children[next];
					if (following === void 0 || roleOf(following) !== "StaticText" || !printable.has(following)) break;
					merged = joinRuns(merged, nameOf(following));
					next += 1;
				}
				index = next - 1;
				if (depthLimit !== void 0 && childDepth > depthLimit) depthElided += 1;
				else if (nodesPrinted >= maxNodes) budgetElided += 1;
				else {
					lines.push(`${"  ".repeat(childDepth)}- StaticText ${quoted(merged)}`);
					nodesPrinted += 1;
				}
				continue;
			}
			const below = units.get(child) ?? 0;
			if (emit(child, childDepth, below)) printChildren(child, childDepth + 1);
		}
	};
	for (const root of start) {
		const forced = options.target !== void 0 && root === start[0];
		if (emit(root, 0, units.get(root) ?? 0, forced)) printChildren(root, 1);
		else if (!printable.has(root)) printChildren(root, 0);
	}
	const notes = [];
	if (budgetElided > 0) notes.push(`… ${String(budgetElided)} more nodes were not printed; take a narrower snapshot with target="<ref or CSS selector>" for one subtree, or depth=<n> to stop at a level`);
	if (depthElided > 0) notes.push(`… ${String(depthElided)} nodes are deeper than depth=${String(depthLimit ?? 0)} and were not printed; raise depth to see them`);
	const body = lines.join("\n");
	const note = notes.join("\n");
	labels.observe(present);
	return {
		text: note === "" ? body : body === "" ? note : `${body}\n\n${note}`,
		refs,
		truncated: budgetElided > 0 || depthElided > 0,
		nodes: nodesPrinted,
		elided: {
			budget: budgetElided,
			depth: depthElided
		},
		fresh
	};
}
/**
* The AX node behind a target.
* @param nodes - the flat node list CDP returned.
* @param target - the node the caller named.
* @returns the node to print from.
* @throws {Error} when the tree holds no node for that DOM node.
*/
function targetNode(nodes, target) {
	const found = nodes.find((node) => node.backendDOMNodeId === target.backendNodeId);
	if (found === void 0) throw new Error(`dsh-browser: ${target.described} has no node in the accessibility tree; take a snapshot of the whole page and pick a ref from it`);
	return found;
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
//#endregion
//#region src/config.ts
/** The whitelisted accessibility properties a snapshot prints, as a schema default. */
const SNAPSHOT_ATTRIBUTES_DEFAULT = DEFAULT_ATTRIBUTES.join(", ");
/** The selector a page marks elements no snapshot should print with, by default. */
const SNAPSHOT_IGNORE_DEFAULT = "[data-dsh-browser-ignore]";
/**
* Read a comma-separated configuration list.
*
* Both snapshot settings are lists a user types into one settings field: which
* properties to print, and which selectors to leave out. A comma is the natural
* separator for both, and it is also what a CSS selector list uses, so a value
* like `nav, footer` means two selectors.
* @param value - the configured string.
* @returns the entries, trimmed, with the empty ones dropped.
*/
function listOf(value) {
	return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}
/**
* Read the current values out of a resolved configuration.
*
* Called per use rather than once, because a volatile field's contents change
* when the settings page writes one; the wrapper is what stays the same.
* @param config - the configuration the loader holds.
* @returns the plain configuration the rest of the plugin works with.
*/
function plainConfig(config) {
	return {
		...config,
		channel: config.channel.get(),
		executablePath: config.executablePath.get(),
		headless: config.headless.get(),
		userDataDir: config.userDataDir.get(),
		debugPortMin: config.debugPortMin.get(),
		debugPortMax: config.debugPortMax.get(),
		viewportWidth: config.viewportWidth.get(),
		viewportHeight: config.viewportHeight.get(),
		stealth: config.stealth.get(),
		quality: config.quality.get(),
		snapshotAttributes: config.snapshotAttributes.get(),
		snapshotIgnore: config.snapshotIgnore.get()
	};
}
/**
* Schema for {@link BrowserConfigInput}.
*
* Marking a field volatile is what puts it on the settings page: the shell
* exposes exactly the fields a volatile ancestor makes editable, and rewrites
* them in place instead of remounting the plugin, so a running browser is
* restarted onto the new values rather than losing the pane watching it.
* Launch and encoding fields are volatile for that reason; the rest are
* ordinary configuration, changeable from cordis.yml.
*/
const Config = z.object({
	channel: z.union([z.const("chrome"), z.const("msedge")]).default("chrome").volatile(),
	executablePath: z.string().default("").volatile(),
	headless: z.boolean().default(true).volatile(),
	userDataDir: z.string().default("").volatile(),
	debugPortMin: z.natural().min(1).max(65535).default(9333).volatile(),
	debugPortMax: z.natural().min(1).max(65535).default(9400).volatile(),
	viewportWidth: z.natural().default(1440).volatile(),
	viewportHeight: z.natural().default(900).volatile(),
	stealth: z.boolean().default(true).volatile(),
	startupUrl: z.string().default("about:blank"),
	quality: z.natural().min(1).max(100).default(70).volatile(),
	maxWidth: z.natural().default(1600),
	maxHeight: z.natural().default(1200),
	everyNthFrame: z.natural().default(1),
	snapshotNodes: z.natural().min(1).default(500),
	snapshotAttributes: z.string().default(SNAPSHOT_ATTRIBUTES_DEFAULT).volatile(),
	snapshotIgnore: z.string().default(SNAPSHOT_IGNORE_DEFAULT).volatile(),
	maxInstances: z.natural().min(1).max(16).default(4),
	extraArgs: z.array(z.string()).default([])
});
//#endregion
//#region src/browser/page-info.ts
/**
* Read page geometry out of layout metrics.
*
* The content size is what the page scrolls to, but a page shorter than its
* window reports a content size smaller than the viewport; the larger of the two
* is what "the whole page is in view" has to be measured against. A scroll
* offset on a page that no longer scrolls is stale, so it is dropped rather than
* reported as a position the page is not at.
* @param metrics - the CDP result, or anything else that arrived.
* @returns the geometry to describe.
*/
function pageInfoFromMetrics(metrics) {
	const read = metrics ?? {};
	const viewport = read.cssVisualViewport ?? read.cssLayoutViewport ?? {};
	const viewportWidth = viewport.clientWidth ?? 0;
	const viewportHeight = viewport.clientHeight ?? 0;
	const pageWidth = Math.max(read.cssContentSize?.width ?? 0, viewportWidth);
	const pageHeight = Math.max(read.cssContentSize?.height ?? 0, viewportHeight);
	const offset = pageHeight > viewportHeight ? Math.max(0, read.cssLayoutViewport?.pageY ?? 0) : 0;
	return {
		viewportWidth,
		viewportHeight,
		pageWidth,
		pageHeight,
		scrolledY: Math.min(offset, pageHeight - viewportHeight)
	};
}
/**
* Describe page geometry in one line.
* @param info - the geometry to describe.
* @returns the `Page info:` line a snapshot header carries.
*/
function formatPageInfo(info) {
	if (info.viewportHeight <= 0 || info.viewportWidth <= 0) return "Page info: the page reported no viewport size";
	const viewport = `${String(info.viewportWidth)}x${String(info.viewportHeight)}`;
	const page = `${String(info.pageWidth)}x${String(info.pageHeight)}`;
	if (info.pageHeight <= info.viewportHeight) return `Page info: ${viewport} viewport, page ${page} — the whole page is in view`;
	const screens = Math.ceil(info.pageHeight / info.viewportHeight);
	const below = info.pageHeight - info.viewportHeight - info.scrolledY;
	const screen = Math.floor(info.scrolledY / info.viewportHeight) + 1;
	const position = info.scrolledY <= 0 ? "at the top" : below <= 0 ? "at the bottom" : `${String(info.scrolledY)} px scrolled (${String(Math.round(info.scrolledY / info.pageHeight * 100))}%)`;
	const other = below <= 0 ? `${String(info.scrolledY)} px above` : `${String(below)} px below`;
	return `Page info: ${viewport} viewport, page ${page} (${String(screens)} screens) — ${position}, ${other}, screen ${String(screen)} of ${String(screens)}`;
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
/**
* How long a page must stay still before an action is called settled.
*
* Short enough not to tax a page that is already done, long enough that a
* client-rendered menu or a filtered list has drawn by the time the result is
* written. This is Playwright MCP's default settle window, for the same reason.
*/
const SETTLE_QUIET_MS = 500;
/** Longest an action waits for a page to stop changing. */
const SETTLE_MAX_MS = 3e3;
/**
* How long one attempt to stop a cancelled call's page is given.
*
* A page that is answering stops its load or terminates its script within a
* frame. One that has not answered by now is not going to, and waiting longer
* only holds up the call that has already given up.
*/
const INTERRUPT_QUIET_MS = 1e3;
/**
* How long the mirror is given to attach before the browser is reported ready.
*
* The mirror is a view of the browser, not the browser: a page that will not
* answer `Page.startScreencast` — a wedged renderer — must not hold up every
* later call, because a start in flight is a start every caller joins.
*/
const START_MIRROR_MS = 5e3;
/** Why a browser that did not answer a cancelled call is dropped. */
const UNREACHABLE_REASON = "the browser did not answer after the call that was cancelled";
/** How long an action waits for a navigation it triggered to reach the document. */
const SETTLE_NAVIGATION_MS = 2e3;
/**
* Where an armed settle probe parks its promise on the page.
*
* A slot per action rather than one fixed name: two actions in flight on the
* same page would otherwise read each other's record.
*/
const SETTLE_SLOT = "__dshSettle";
/**
* Fields a running browser was launched from; changing one requires a new browser.
*
* The port window is deliberately absent. What a browser listens on is the port
* the allocator handed it, not a configuration value, so moving the window only
* decides where the *next* browser may listen — a settings tweak that should not
* close browsers someone is watching. The ports already handed out stay held
* until their browsers close.
*/
const LAUNCH_FIELDS = [
	"channel",
	"executablePath",
	"headless",
	"userDataDir",
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
* Whether a CDP failure means the element behind a ref is no longer in the DOM.
*
* Chrome answers a call about a removed node in a few different ways depending
* on the call, and each of them is worth one attempt to find the element again;
* anything else — a page that threw, a browser that went away — is the caller's
* error and is reported as it is.
* @param error - what the protocol call rejected with.
* @returns whether the element itself is gone.
*/
function elementGone(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /no node with given id|node with given id|no node found|could not find node|detached|not attached/iu.test(message);
}
/**
* The in-page expression an action settles with.
*
* It reports how many mutation records the page produced while the observer was
* installed and whether the page went quiet inside the budget, which is what
* turns "the click returned" into "the page stopped moving".
* @returns the expression to evaluate in the page.
*/
function settleProbe() {
	return `new Promise((resolve) => {
    let mutations = 0
    let quiet = 0
    let cap = 0
    const finish = (settled) => {
      observer.disconnect()
      clearTimeout(quiet)
      clearTimeout(cap)
      resolve({ mutations, settled })
    }
    const observer = new MutationObserver((records) => {
      mutations += records.length
      clearTimeout(quiet)
      quiet = setTimeout(() => { finish(true) }, ${String(SETTLE_QUIET_MS)})
    })
    observer.observe(globalThis.document.documentElement ?? globalThis.document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    })
    quiet = setTimeout(() => { finish(true) }, ${String(SETTLE_QUIET_MS)})
    cap = setTimeout(() => { finish(false) }, ${String(SETTLE_MAX_MS)})
  })`;
}
/**
* The in-page question a press asks about itself.
*
* The page is the authority on both halves: `getBoundingClientRect` is already
* in the pixels input is dispatched in, and `elementFromPoint` is the same
* question a real press asks. A shadow host is followed into its own tree so it
* cannot be mistaken for something lying over the target, a `StaticText` ref is
* answered by the element around it, and the box is read twice so an element
* that is still moving is not pressed where it used to be.
* @returns the function to call on the element a click is about to press.
*/
function pressProbe() {
	return `async function () {
    const element = this.nodeType === 1 ? this : this.parentElement
    if (element === null || typeof element.getBoundingClientRect !== 'function') return { ok: false }
    const box = () => element.getBoundingClientRect()
    const view = element.ownerDocument.defaultView
    const first = box()
    await new Promise((done) => {
      let waited = false
      const finish = () => { if (!waited) { waited = true; done() } }
      if (view !== null && typeof view.requestAnimationFrame === 'function') {
        view.requestAnimationFrame(() => view.requestAnimationFrame(finish))
      }
      // A page that never paints — a background tab — must not hold the press up.
      if (view !== null && typeof view.setTimeout === 'function') view.setTimeout(finish, 50)
    })
    const settled = box()
    const moved = Math.abs(settled.left - first.left) > 1 || Math.abs(settled.top - first.top) > 1
    if (settled.width === 0 && settled.height === 0) return { ok: false }
    const localX = settled.left + settled.width / 2
    const localY = settled.top + settled.height / 2
    // A press is dispatched in the top frame's pixels, so the point walks out of
    // every frame this element sits in.
    let x = localX
    let y = localY
    let outer = view
    let frame = view === null ? null : view.frameElement
    for (let hop = 0; frame !== null && hop < 32; hop += 1) {
      const frameBox = frame.getBoundingClientRect()
      x += frameBox.left
      y += frameBox.top
      const parent = frame.ownerDocument.defaultView
      outer = parent
      frame = parent === null ? null : parent.frameElement
    }
    const inView = outer !== null && x >= 0 && y >= 0 && x < outer.innerWidth && y < outer.innerHeight
    if (!inView) return { ok: true, x, y, moved, inView, mine: false, over: null }
    // What the page says is at the point, and whether that is the element or
    // something inside it: a press on either one reaches the element.
    const within = (node) => {
      let current = node
      for (let hop = 0; current !== null && hop < 64; hop += 1) {
        if (current === element) return true
        const parent = current.parentNode
        const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null
        current = parent !== null ? parent : (root !== null && root.host !== undefined ? root.host : null)
      }
      return false
    }
    let top = element.ownerDocument.elementFromPoint(localX, localY)
    while (top !== null && top.shadowRoot !== null) {
      const inner = top.shadowRoot.elementFromPoint(localX, localY)
      if (inner === null || inner === top) break
      top = inner
    }
    const mine = top !== null && (top === element || element.contains(top) || within(top))
    if (mine || top === null) return { ok: true, x, y, moved, inView, mine, over: null }
    const name = top.getAttribute('aria-label') ?? top.textContent ?? ''
    return {
      ok: true, x, y, moved, inView, mine,
      over: {
        role: top.getAttribute('role') ?? top.tagName.toLowerCase(),
        name: String(name).replace(/\\s+/g, ' ').trim().slice(0, 80),
      },
    }
  }`;
}
/**
* Read what a page answered about a press.
*
* The answer is another program's output, so every field is checked before it is
* believed; `'boxless'` is the page saying the element has no box at all, and
* `undefined` is the page saying nothing this code can use.
* @param value - the value `Runtime.callFunctionOn` returned.
* @returns the point, `'boxless'`, or `undefined` when there was no usable answer.
*/
function readPress(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const said = value;
	if (said["ok"] === false) return "boxless";
	if (said["ok"] !== true) return void 0;
	const x = said["x"];
	const y = said["y"];
	if (typeof x !== "number" || typeof y !== "number") return void 0;
	const over = said["over"];
	const described = typeof over === "object" && over !== null ? over : void 0;
	const role = described?.["role"];
	const name = described?.["name"];
	return {
		x,
		y,
		moved: said["moved"] === true,
		outside: said["inView"] === false,
		...typeof role === "string" ? { over: {
			role,
			name: typeof name === "string" ? name : ""
		} } : {}
	};
}
/**
* An element as an error names it.
* @param element - the role and name of an element.
* @returns the role followed by the quoted name.
*/
function elementName(element) {
	return `${element.role} ${JSON.stringify(element.name)}`;
}
/**
* The error a ref gets when its element has no box to press.
* @param target - the element the ref names.
* @returns the error to throw.
*/
function boxlessError(target) {
	return /* @__PURE__ */ new Error(`dsh-browser: ${elementName(target)} has no visible box in the page; take a new snapshot and try again`);
}
/**
* The in-page question asked after a focus and before any text.
*
* `DOM.focus` succeeding is not the same as the characters landing in the
* element: measured 2026-09-24 in real Chrome, `Input.insertText` into a
* read-only input inserted nothing while the report still said the text had been
* typed. Only the page knows whether the control it focused can hold text, so it
* is asked — and asked about its own `activeElement`, because a focus that
* landed somewhere else is the other way text goes missing.
* @returns the function to call on the element a type is about to write into.
*/
function typedProbe() {
	return `function () {
    const element = this.nodeType === 1 ? this : this.parentElement
    if (element === null) return { accepts: false, why: 'it is not an element' }
    const active = element.ownerDocument.activeElement
    if (active === null || (active !== element && !element.contains(active))) {
      return { accepts: false, why: 'the page did not focus it' }
    }
    if (active.disabled === true) return { accepts: false, why: 'it is disabled' }
    if (active.readOnly === true) return { accepts: false, why: 'it is read-only' }
    const tag = String(active.tagName === undefined ? '' : active.tagName).toLowerCase()
    const type = String(active.type === undefined ? '' : active.type).toLowerCase()
    const textless = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
    if (tag === 'textarea' || (tag === 'input' && textless.indexOf(type) === -1)) return { accepts: true }
    if (active.isContentEditable === true) return { accepts: true }
    return { accepts: false, why: 'it takes no typed text' }
  }`;
}
/**
* Read what a page answered about typing.
* @param value - the value `Runtime.callFunctionOn` returned.
* @returns the answer, or `undefined` when the page said nothing this code can use.
*/
function readTyped(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const said = value;
	if (said["accepts"] === true) return { accepts: true };
	if (said["accepts"] !== false) return void 0;
	const why = said["why"];
	return {
		accepts: false,
		why: typeof why === "string" ? why : "the page would not take it"
	};
}
/**
* The error a ref gets when the page says the text would not land in it.
* @param target - the element the ref names.
* @param why - the page's reason.
* @returns the error to throw.
*/
function untypableError(target, why) {
	return /* @__PURE__ */ new Error(`dsh-browser: ${elementName(target)} would not take the text because ${why}; nothing was typed, so take a new snapshot and check the element`);
}
/**
* One call's source, wrapped so its declarations belong to that call.
*
* The page's global scope keeps what an earlier call declared: a `const` or
* `class` of the same name is a syntax error before anything runs. A block is
* enough to give the source a scope of its own, and the block's completion value
* is what the call would have produced unwrapped.
* @param expression - the caller's source.
* @returns the source as one block statement.
*/
function scopedBlock(expression) {
	return `{\n${expression}\n}`;
}
/**
* Wait for a promise, but only until a deadline.
*
* For the work this class can afford to give up on: a page being told to stop,
* a mirror being attached. A rejection counts as settled — a browser that
* refused is a browser that answered — and the abandoned promise's failure is
* swallowed here rather than surfacing as an unhandled rejection.
* @param work - the promise to wait for.
* @param ms - how long it is given.
* @returns whether it settled in time, and what it produced.
*/
async function until(work, ms) {
	let timer;
	try {
		return await Promise.race([work.then((value) => ({
			settled: true,
			value
		}), () => ({ settled: true })), new Promise((done) => {
			timer = setTimeout(() => {
				done({ settled: false });
			}, ms);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
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
	/**
	* Labels this page has handed out, by ref.
	*
	* It belongs to the page rather than to a snapshot: a ref taken before a menu
	* opened still names the element it named then, and re-printing the page does
	* not renumber the ones already handed out. A page that goes away takes its
	* labels with it, because a backend node id means nothing on another page.
	*/
	labels = new RefLabels();
	/** Set while this class itself is closing the browser, so it is not a death. */
	closing = false;
	/** How many settle probes this browser has armed, for a slot no two share. */
	settleSeq = 0;
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
	* Stop what the page is doing, for a call that was cancelled.
	*
	* A navigation still in flight is stopped and a script still executing is
	* terminated, because the call that started them has given up: left alone,
	* the page stays busy and the next call inherits work nobody is waiting for.
	* A browser that answers neither is not one the next call can use either, so
	* it is dropped and the call after it starts a fresh one — the alternative is
	* a browser that hangs every call from here on, which is what closing the
	* window by hand was the only way out of.
	* @returns after the browser has been told to stop, or has been dropped.
	*/
	async interrupt() {
		const cdp = this.cdp;
		if (cdp === void 0) return;
		const [loading, script] = await Promise.all([until(cdp.send("Page.stopLoading"), INTERRUPT_QUIET_MS), until(cdp.send("Runtime.terminateExecution"), INTERRUPT_QUIET_MS)]);
		if (loading.settled || script.settled) return;
		this.logger.warn(/* @__PURE__ */ new Error(`dsh-browser: session ${this.sessionId}'s browser did not answer after a cancelled call; dropping it`));
		this.forget();
		this.reason = UNREACHABLE_REASON;
		this.setState("closed");
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
	* Open an address in the active page and report what the page became.
	* @param url - absolute address to load.
	* @returns where the page landed, and what changed to get there.
	*/
	async navigate(url) {
		await this.ensure();
		const before = await this.stateOf();
		const page = this.requirePage();
		this.viewport = void 0;
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 3e4
		});
		this.publish();
		return await this.settle(before, {});
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
	* Refs keep whatever label the page already gave them, so a ref from an
	* earlier snapshot of this page still names the same element; only a page that
	* goes away clears them. The budget, the depth limit, and a target subtree are
	* what keep a large page from spending the conversation's context on itself.
	* @param options - a subtree to print, and how deep to print it.
	* @returns the tree as text, the refs it used, and the page geometry.
	* @throws {Error} when a target names nothing on the page.
	*/
	async snapshot(options = {}) {
		await this.ensure();
		const cdp = this.cdpSession();
		const ignore = await this.ignoredNodes(cdp);
		const target = options.target === void 0 ? void 0 : await this.resolveTarget(cdp, options.target);
		const tree = await cdp.send("Accessibility.getFullAXTree");
		const attributes = listOf(this.config.snapshotAttributes);
		const snapshot = formatAxTree(tree.nodes ?? [], {
			maxNodes: this.config.snapshotNodes,
			labels: this.labels,
			...attributes.length === 0 ? {} : { attributes },
			...target === void 0 ? {} : { target },
			...options.depth === void 0 ? {} : { depth: options.depth },
			...ignore.size === 0 ? {} : { ignore }
		});
		const metrics = await cdp.send("Page.getLayoutMetrics");
		return {
			...snapshot,
			info: pageInfoFromMetrics(metrics)
		};
	}
	/**
	* The elements the page asked to keep out of a snapshot.
	*
	* A site can mark what is decoration, or what the plugin should never print,
	* with a selector the configuration names; those DOM nodes are resolved to the
	* accessibility nodes behind them once per snapshot, which costs two protocol
	* calls when nothing matches and one per match when something does.
	* @param cdp - session attached to the active page.
	* @returns the backend node ids to drop.
	*/
	async ignoredNodes(cdp) {
		const ignored = /* @__PURE__ */ new Set();
		const selectors = listOf(this.config.snapshotIgnore);
		if (selectors.length === 0) return ignored;
		const rootNodeId = (await cdp.send("DOM.getDocument", { depth: 0 }).catch(() => void 0))?.root?.nodeId;
		if (rootNodeId === void 0) return ignored;
		for (const selector of selectors) {
			const found = await cdp.send("DOM.querySelectorAll", {
				nodeId: rootNodeId,
				selector
			}).catch(() => void 0);
			for (const nodeId of found?.nodeIds ?? []) {
				const described = await cdp.send("DOM.describeNode", {
					nodeId,
					depth: -1,
					pierce: false
				}).catch(() => void 0);
				const walk = (node) => {
					if (node === void 0) return;
					if (node.backendNodeId !== void 0) ignored.add(node.backendNodeId);
					for (const child of node.children ?? []) walk(child);
				};
				walk(described?.node);
			}
		}
		return ignored;
	}
	/**
	* Resolve what a snapshot's `target` names.
	* @param cdp - session attached to the active page.
	* @param target - a ref this page handed out, or a CSS selector.
	* @returns the DOM node to print from.
	* @throws {Error} when the ref is unknown or the selector matches nothing.
	*/
	async resolveTarget(cdp, target) {
		const known = this.labels.targetOf(target);
		if (known !== void 0) return {
			backendNodeId: known.backendNodeId,
			described: target
		};
		if (/^e\d+$/.test(target)) throw new Error(`dsh-browser: ${target} is not a ref from a snapshot of the current page; call browser_snapshot and use a ref from its result`);
		const rootNodeId = (await cdp.send("DOM.getDocument", { depth: 0 })).root?.nodeId;
		if (rootNodeId === void 0) throw new Error(`dsh-browser: could not read the page to look up ${target}`);
		const found = await cdp.send("DOM.querySelector", {
			nodeId: rootNodeId,
			selector: target
		});
		if (found.nodeId === void 0 || found.nodeId === 0) throw new Error(`dsh-browser: no element matches ${target}; check the selector, or take a full snapshot and use a ref`);
		const described = await cdp.send("DOM.describeNode", { nodeId: found.nodeId });
		if (described.node?.backendNodeId === void 0) throw new Error(`dsh-browser: no element matches ${target}; check the selector, or take a full snapshot and use a ref`);
		return {
			backendNodeId: described.node.backendNodeId,
			described: target
		};
	}
	/**
	* Click the element a ref names, with real mouse events.
	*
	* The events are dispatched through the same input channel a viewer's clicks
	* use, which is what makes them trusted: a site that ignores a synthetic
	* `element.click()` accepts these. The page is asked where the element is and
	* what a press there would reach, and a press the page says would be received
	* by something else is refused rather than sent — a click that lands on an
	* overlay changes nothing and used to be reported as a success.
	* @param ref - a ref from a snapshot of the current page.
	* @param options - `force` presses even when the page says something else would receive it.
	* @returns the element that was clicked, where the page ended up, and what changed.
	* @throws {Error} when the ref is unknown, the element has nothing to click, or
	* (without `force`) the press would be received by something other than the element.
	*/
	async click(ref, options = {}) {
		await this.ensure();
		const started = this.page;
		const before = await this.stateOf(started);
		const cdp = this.cdpSession();
		const { target, recovered, result } = await this.actOnRef(ref, async (found) => {
			const point = await this.pressPoint(cdp, found);
			if (point.outside) throw new Error(`dsh-browser: ${elementName(found)} is outside the viewport even after scrolling it into view, so the click has nowhere to land; take a new snapshot and try again`);
			if (point.over !== void 0 && options.force !== true) throw new Error(`dsh-browser: the click would be received by ${elementName(point.over)}, not ${elementName(found)}; pass force: true to click anyway, or take a new snapshot of what is over it`);
			const watch = await this.armSettle(cdp, started);
			await dispatchInput(cdp, {
				type: "mouse",
				action: "move",
				x: point.x,
				y: point.y
			});
			await dispatchInput(cdp, {
				type: "mouse",
				action: "down",
				x: point.x,
				y: point.y
			});
			await dispatchInput(cdp, {
				type: "mouse",
				action: "up",
				x: point.x,
				y: point.y
			});
			return {
				watch,
				obstructed: point.over
			};
		});
		return await this.settle(before, {
			element: {
				role: target.role,
				name: target.name
			},
			recovered,
			...result.obstructed === void 0 ? {} : { obstructed: result.obstructed }
		}, result.watch);
	}
	/**
	* Type into the element a ref names.
	*
	* Text arrives through `Input.insertText`, so it is inserted as characters
	* rather than replayed as keystrokes — which is what makes non-Latin input
	* work. A key is pressed afterwards for fields whose meaning is the Enter
	* that follows. The page is asked after the focus and before the first
	* character whether it will take the text at all, because a control that
	* cannot hold it takes nothing while the report used to say it had been typed.
	* @param ref - a ref from a snapshot of the current page.
	* @param value - the text to insert.
	* @param options - whether to replace the current content, and a key to press after.
	* @returns the element that was typed into, where the page ended up, and what changed.
	* @throws {Error} when the ref is unknown, or the page says the text would not land in it.
	*/
	async type(ref, value, options = {}) {
		await this.ensure();
		const started = this.page;
		const before = await this.stateOf(started);
		const cdp = this.cdpSession();
		const { target, recovered, result } = await this.actOnRef(ref, async (found) => {
			await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: found.backendNodeId }).catch(() => {});
			await cdp.send("DOM.focus", { backendNodeId: found.backendNodeId });
			await this.assertTyped(cdp, found);
			if (options.clear !== false) await this.evaluateIn(cdp, "globalThis.document.activeElement?.select?.()").catch(() => {});
			const watch = await this.armSettle(cdp, started);
			if (value !== "") await dispatchInput(cdp, {
				type: "text",
				text: value
			});
			if (options.key !== void 0) await dispatchInput(cdp, {
				type: "key",
				key: options.key
			});
			return watch;
		});
		return await this.settle(before, {
			element: {
				role: target.role,
				name: target.name
			},
			recovered
		}, result);
	}
	/**
	* Act on a ref, finding the element again if the DOM replaced it.
	*
	* A single-page app re-renders an element by removing the old node and
	* inserting a new one, which leaves the ref pointing at nothing while the
	* element the model asked for is still on the page. The role and name the
	* snapshot recorded are enough to find it again, and a failed action is only
	* retried when exactly one element matches, so a retry can never land
	* somewhere the model did not name.
	* @param ref - a ref from a snapshot of the current page.
	* @param run - the action, given the element it should act on.
	* @returns what the action acted on, whether it had to be found again, and
	* whatever the action itself produced.
	* @throws {Error} when the ref is unknown, or when the action fails for a
	* reason other than the element having gone.
	*/
	async actOnRef(ref, run) {
		const target = this.nodeFor(ref);
		try {
			return {
				target,
				recovered: false,
				result: await run(target)
			};
		} catch (error) {
			if (!elementGone(error)) throw error;
			const healed = await this.findAgain(ref, target);
			if (healed === void 0) throw error;
			return {
				target: healed,
				recovered: true,
				result: await run(healed)
			};
		}
	}
	/**
	* Find the element a ref named, after the DOM node behind it went away.
	* @param ref - the ref to re-point.
	* @param stale - what the ref named when the snapshot recorded it.
	* @returns the element's new DOM node, or `undefined` when the page has no
	* single element matching it.
	*/
	async findAgain(ref, stale) {
		const tree = await this.cdpSession().send("Accessibility.getFullAXTree").catch(() => void 0);
		const matches = [];
		for (const node of tree?.nodes ?? []) {
			const candidate = refTargetOf(node);
			if (candidate !== void 0 && candidate.role === stale.role && candidate.name === stale.name) matches.push(candidate);
		}
		const found = matches.length === 1 ? matches[0] : void 0;
		if (found === void 0) return void 0;
		this.labels.rebind(ref, found);
		return found;
	}
	/** What the active page shows right now. */
	async stateOf(page = this.page) {
		if (page === void 0) return {
			url: "",
			title: ""
		};
		return {
			url: page.url(),
			title: await page.title().catch(() => "")
		};
	}
	/**
	* Wait for a page to stop changing, then describe what it became.
	*
	* A click on a client-rendered control returns from the protocol before the
	* page has drawn the result, and a click on a link returns before the next
	* document exists. Waiting for the document and then for a quiet moment is
	* what makes the reported address and title the ones the model will act on.
	* @param before - the page state the action started from.
	* @param detail - the element acted on, whether it had to be found again, and
	* what was over the point it was clicked at.
	* @param armed - the probe a caller installed before dispatching its input.
	* @returns the report a tool result is rendered from.
	*/
	async settle(before, detail, armed) {
		const started = armed?.page ?? this.page;
		if (started !== void 0) await started.waitForLoadState("domcontentloaded", { timeout: SETTLE_NAVIGATION_MS }).catch(() => {});
		const watch = armed !== void 0 && armed.page === this.page ? armed : this.cdp === void 0 || this.page === void 0 ? void 0 : await this.armSettle(this.cdp, this.page);
		let mutations = 0;
		let settled = true;
		if (watch !== void 0) {
			const record = await this.readSettle(watch);
			mutations = record.mutations;
			settled = record.settled;
		}
		const after = await this.stateOf(this.page ?? started);
		const changed = [];
		if (after.url !== before.url) changed.push("url");
		if (after.title !== before.title) changed.push("title");
		if (mutations > 0) changed.push("dom");
		return {
			url: after.url,
			title: after.title,
			changed,
			mutations,
			settled,
			...detail.element === void 0 ? {} : { element: detail.element },
			...detail.recovered === void 0 ? {} : { recovered: detail.recovered },
			...detail.obstructed === void 0 ? {} : { obstructed: detail.obstructed }
		};
	}
	/**
	* Start watching a page for changes, before the action that causes them.
	*
	* The observer has to be installed first. A page that reacts inside its own
	* handler — a `<details>` opening, a class toggled by a script — has finished
	* by the time the protocol call returns, and a probe started after that sees
	* a page that never moved: measured 2026-09-25 on github.com/trending, where
	* clicking a disclosure reported "did not change" while its menu opened. Only
	* a reaction that is deferred to a later task was ever seen.
	* @param cdp - session attached to the page being acted on.
	* @param page - the page the action is about to act on.
	* @returns where to read what the probe saw.
	*/
	async armSettle(cdp, page) {
		this.settleSeq += 1;
		const slot = `${SETTLE_SLOT}${String(this.settleSeq)}`;
		await this.evaluateIn(cdp, `(globalThis.${slot} = ${settleProbe()}, 0)`).catch(() => {});
		return {
			page,
			cdp,
			slot
		};
	}
	/**
	* Read what an armed probe saw, and let the page drop it.
	* @param watch - the page and slot the probe was installed with.
	* @returns how many mutation records it saw, and whether the page went quiet.
	*/
	async readSettle(watch) {
		const none = {
			mutations: 0,
			settled: true
		};
		const observed = await this.evaluateIn(watch.cdp, `(async () => { const record = await globalThis.${watch.slot}; globalThis.${watch.slot} = undefined; return record })()`).catch(() => void 0);
		if (typeof observed !== "object" || observed === null) return none;
		const record = observed;
		return {
			mutations: typeof record.mutations === "number" ? record.mutations : 0,
			settled: typeof record.settled === "boolean" ? record.settled : true
		};
	}
	/**
	* Where a press on a ref's element would land, and what the page says about it.
	*
	* The page is asked rather than the protocol, because the protocol's answer has
	* to be interpreted: measured 2026-09-24 on a scrolled Google result page,
	* `DOM.getContentQuads` returned the frame's viewport pixels (433 for a box
	* 2471 px down the document), so translating them by
	* `cssLayoutViewport.pageY` — as this used to — put the press at y = -1589,
	* outside the viewport, where it reached nothing while the report still called
	* the click a success. `getBoundingClientRect` needs no interpretation and
	* answers for nested scroll containers too.
	* @param cdp - session attached to the active page.
	* @param target - the element a ref names.
	* @returns the point to press, and what would receive it when that is not the element.
	* @throws {Error} when the element has no box in the page.
	*/
	async pressPoint(cdp, target) {
		await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }).catch(() => {});
		const objectId = (await cdp.send("DOM.resolveNode", { backendNodeId: target.backendNodeId }).catch(() => void 0))?.object?.objectId;
		if (objectId !== void 0) for (let attempt = 0; attempt < 2; attempt += 1) {
			const said = readPress((await cdp.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: pressProbe(),
				awaitPromise: true,
				returnByValue: true
			}).catch(() => void 0))?.result?.value);
			if (said === "boxless") throw boxlessError(target);
			if (said === void 0) break;
			if (!said.moved || attempt === 1) return said;
		}
		const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId: target.backendNodeId });
		const quad = quads?.[0];
		if (quad === void 0) throw boxlessError(target);
		const centre = centerOfQuad(quad);
		return {
			x: centre.x,
			y: centre.y,
			moved: false,
			outside: false
		};
	}
	/**
	* Ask the page whether the element it just focused will take typed text.
	*
	* Called before the old value is selected and before any character is
	* inserted, so a control that cannot hold text is refused instead of reported
	* as typed into. A page that says nothing this code can read does not block
	* the text: this is a question the page answers, not a requirement it has to
	* satisfy, and the same shape of answer — a node CDP has already replaced —
	* leaves the old behaviour in place.
	* @param cdp - session attached to the active page.
	* @param target - the element a ref names.
	* @throws {Error} when the page says the text would not land in the element.
	*/
	async assertTyped(cdp, target) {
		const objectId = (await cdp.send("DOM.resolveNode", { backendNodeId: target.backendNodeId }).catch(() => void 0))?.object?.objectId;
		if (objectId === void 0) return;
		const said = readTyped((await cdp.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: typedProbe(),
			awaitPromise: true,
			returnByValue: true
		}).catch(() => void 0))?.result?.value);
		if (said !== void 0 && !said.accepts) throw untypableError(target, said.why ?? "the page would not take it");
	}
	/**
	* The DOM node a ref names, and what it was when the snapshot labelled it.
	* @param ref - a ref from a snapshot of the current page.
	* @returns the element the ref names.
	* @throws {Error} when this page never handed out that ref.
	*/
	nodeFor(ref) {
		const target = this.labels.targetOf(ref);
		if (target === void 0) throw new Error(`dsh-browser: ${ref} is not a ref from a snapshot of the current page; call browser_snapshot and use a ref from its result`);
		return target;
	}
	/**
	* Evaluate an expression over one CDP session.
	*
	* A top-level `await` is a syntax error in the plain form and a valid REPL
	* expression in the other, so the REPL form is the retry rather than the
	* default: measured 2026-09-24, `replMode` also stops `awaitPromise` from
	* unwrapping a returned promise, which would turn `fetch(...)` into `{}`.
	*
	* A declaration the page already has is the second thing worth retrying. The
	* page keeps what an earlier call declared, so a caller that edits one snippet
	* and runs it again is told `Identifier 'el' has already been declared` —
	* a syntax error about the page's scope, not about the snippet. Retried inside
	* a block, the declaration belongs to that call, and everything else about the
	* source behaves the same.
	* @param cdp - session to evaluate on.
	* @param expression - JavaScript source.
	* @param repl - whether to use the REPL form that accepts top-level await.
	* @param scoped - whether the source is already wrapped in a block of its own.
	* @returns the value, decoded when it is JSON-representable.
	* @throws {Error} when the page throws.
	*/
	async evaluateIn(cdp, expression, repl = false, scoped = false) {
		/** Whether the failure is the plain form rejecting a top-level await. */
		const retryable = (message) => !repl && expression.includes("await") && /await is only valid|Unexpected (?:token|reserved word) '?await/iu.test(message);
		/** Whether the page refused the source because its scope already has the name. */
		const redeclared = (message) => !scoped && /has already been declared/u.test(message);
		let outcome;
		try {
			outcome = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
				...repl ? { replMode: true } : {}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (redeclared(message)) return await this.evaluateIn(cdp, scopedBlock(expression), repl, true);
			if (retryable(message)) return await this.evaluateIn(cdp, expression, true, scoped);
			throw error;
		}
		if (outcome.exceptionDetails !== void 0) {
			const detail = outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? "evaluation failed";
			if (redeclared(detail)) return await this.evaluateIn(cdp, scopedBlock(expression), repl, true);
			if (retryable(detail)) return await this.evaluateIn(cdp, expression, true, scoped);
			throw new Error(detail);
		}
		const result = outcome.result;
		if (result?.type === "function") return await this.callResult(cdp, expression, result, repl, scoped);
		return result?.value ?? result?.unserializableValue;
	}
	/**
	* Call a function the caller's expression produced.
	*
	* `() => 1` is a function, not a call, and a function has no value to send
	* back: it arrives as `{}`, which reads as an empty object and hides the fact
	* that nothing ran — including from a model that wrote `history.back()` and
	* was told the page returned nothing.
	* @param cdp - session the expression was evaluated on.
	* @param expression - the source that produced the function.
	* @param result - the remote object the evaluation answered with.
	* @param repl - whether the answer came from the REPL form.
	* @param scoped - whether the source was wrapped in a block of its own.
	* @returns whatever calling the function produced.
	* @throws {Error} when the call throws.
	*/
	async callResult(cdp, expression, result, repl, scoped) {
		if (result.objectId !== void 0) {
			const called = await cdp.send("Runtime.callFunctionOn", {
				objectId: result.objectId,
				functionDeclaration: "function () { return this() }",
				awaitPromise: true,
				returnByValue: true
			});
			if (called.exceptionDetails !== void 0) throw new Error(called.exceptionDetails.exception?.description ?? called.exceptionDetails.text ?? "evaluation failed");
			return called.result?.value ?? called.result?.unserializableValue;
		}
		return await this.evaluateIn(cdp, `(${expression})()`, repl, scoped);
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
			const launchConfig = {
				...this.config,
				debugPort: this.port
			};
			const session = await this.launch(launchConfig, userDataDir);
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
			if (!(await until(this.openStream(), START_MIRROR_MS)).settled) this.logger.warn(/* @__PURE__ */ new Error(`dsh-browser: session ${this.sessionId}'s page did not answer the mirror request; the browser is ready without it`));
			this.logger.info(`dsh-browser: session ${this.sessionId} is on ${page.url()} — CDP on 127.0.0.1:${String(this.port)} (${session.version})`);
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
		this.labels.forgetPage();
		page.on("framenavigated", () => {
			this.labels.forgetPage();
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
		this.allocator = new PortAllocator(portWindow(config.debugPortMin, config.debugPortMax), [], probe);
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
		this.allocator.setWindow(portWindow(next.debugPortMin, next.debugPortMax));
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
//#region src/browser/cancel.ts
/**
* Run one browser operation under the caller's cancellation.
*
* The operation starts only after the signal is being watched, so an abort that
* happens while the call is being set up cannot be missed, and a call that was
* cancelled before it started does not touch the browser at all beyond being
* told to stop.
* @param target - the browser the operation runs on.
* @param signal - the caller's cancellation, when the caller has one.
* @param what - the operation, named in the error a cancellation produces.
* @param work - starts the operation; called at most once.
* @returns what the operation produced.
* @throws {Error} when the call was cancelled, or when the operation failed.
*/
async function cancelable(target, signal, what, work) {
	if (signal === void 0) return await work();
	if (signal.aborted) {
		await target.interrupt();
		throw new Error(cancelled(what));
	}
	let reject = () => {};
	const stopped = new Promise((_resolve, rejectIt) => {
		reject = rejectIt;
	});
	const stop = () => {
		reject(new Error(cancelled(what)));
	};
	signal.addEventListener("abort", stop, { once: true });
	const started = work();
	started.catch(() => {});
	try {
		return await Promise.race([started, stopped]);
	} catch (error) {
		if (signal.aborted) await target.interrupt();
		throw error;
	} finally {
		signal.removeEventListener("abort", stop);
	}
}
/**
* What a cancelled call reports.
* @param what - the operation that was cancelled.
* @returns the message the caller sees.
*/
function cancelled(what) {
	return `dsh-browser: ${what} was cancelled by the caller; the page was stopped, and the browser is free for the next call`;
}
/** Lines a spill preview keeps inline. */
const PREVIEW_LINES = 20;
/** Makes each fallback file name unique within one process. */
let counter = 0;
/**
* Whether a result should be written to a file.
* @param text - the text the tool produced.
* @param requested - whether the caller asked for a file.
* @returns whether to spill.
*/
function shouldSpill(text, requested) {
	return requested || text.length > 4e4;
}
/**
* The harness spill store, when the composition mounts one.
*
* Looked up through the context rather than injected: this plugin works in a
* composition without `dsh-spill-local`, and a missing store is a fallback
* rather than a failure to load. The lookup is structural because the plugin
* deliberately does not depend on `@deepseek-ai/dsh-spill`.
* @param ctx - the plugin context.
* @returns the store, or `undefined` when the composition has none.
*/
function spillStoreOf(ctx) {
	const lookup = ctx.get;
	if (typeof lookup !== "function") return void 0;
	const candidate = lookup.call(ctx, "spillStore");
	return typeof candidate?.saveText === "function" ? candidate : void 0;
}
/**
* The head of a text, with the rest announced.
* @param text - the full text.
* @param lines - how many lines to keep.
* @returns the preview, or the text itself when it is short enough.
*/
function preview(text, lines = PREVIEW_LINES) {
	const all = text.split("\n");
	if (all.length <= lines) return text;
	return [...all.slice(0, lines), `… ${String(all.length - lines)} more lines are in the file.`].join("\n");
}
/**
* Write one text where the model can read it back.
* @param text - the text to persist.
* @param options - where to write, who the result belongs to, and which store to prefer.
* @returns the path and the retrieval hint.
*/
async function writeText(text, options) {
	const suggestedName = `${options.toolName}-${options.label}.txt`;
	if (options.store !== void 0 && options.sessionId !== void 0) try {
		const saved = await options.store.saveText({
			owner: { sessionId: options.sessionId },
			source: {
				kind: "tool",
				toolName: options.toolName,
				callId: options.callId ?? "unknown",
				label: options.label
			},
			suggestedName,
			content: text
		});
		return {
			path: String(saved.locator),
			hint: saved.retrievalHint,
			bytes: saved.bytes
		};
	} catch {}
	counter += 1;
	const safe = suggestedName.replace(/[^A-Za-z0-9._-]/g, "_");
	const path = join(options.dir, `${String(Date.now())}-${String(counter)}-${safe}`);
	await mkdir(options.dir, { recursive: true });
	await writeFile(path, text, "utf8");
	return {
		path,
		hint: `read ${path} with your file tools; grep it if it is long`,
		bytes: Buffer.byteLength(text)
	};
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
* A tool result is written for a model that cannot see the page: it says what
* the element was, where the page ended up, and whether anything changed, rather
* than repeating the arguments. A snapshot that had to leave something out says
* which parameter would have printed it, and a page too large to read inline is
* written to a file whose path comes back instead (see `spill.ts`).
*
* A tool addresses the browser of the session that called it, taken from the
* execution's agent, so two conversations never touch each other's pages. A
* call with no session — a scheduled job, or a subagent without one — fails
* rather than landing in somebody's browser.
*
* Every call runs under the caller's cancellation and declares a budget. The
* harness keeps waiting for the promise a tool body returned, so a body that
* waits on a browser which never answers is a call that never finishes — and a
* conversation that cannot be stopped (measured 2026-09-25: a navigation that
* outlived an interrupt and a turn restart). The body therefore gives up as
* soon as the signal aborts, and the browser is told to stop what the cancelled
* call had started.
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
/** Directory snapshot spills are written to when the composition mounts no spill store. */
const SNAP_DIR = join(tmpdir(), "dsh-browser-snapshots");
/**
* Budget for opening an address, in milliseconds.
*
* Larger than the navigation's own 30 s budget on purpose: a page that is merely
* slow reports Playwright's failure — which names the address and the timeout —
* and this one is left for a call the browser never comes back from.
*/
const NAVIGATE_TIMEOUT_MS = 45e3;
/** Budget for reading or acting on a page, in milliseconds. */
const PAGE_TIMEOUT_MS = 3e4;
/**
* Budget for evaluating in a page, in milliseconds.
*
* Larger than the rest because the expression is the caller's own work: waiting
* for a page, polling an endpoint, and anything else a short program does is a
* legitimate use of the tool rather than a browser that has stopped answering.
*/
const EVALUATE_TIMEOUT_MS = 12e4;
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
/**
* What an action did to the page, in the words the model needs.
*
* "Nothing changed" is as important as a change: it is the difference between a
* click that worked and a click that landed on a disabled control, and only the
* page can say which happened.
* @param report - what the action reported about the page.
* @returns one line describing the outcome.
*/
function changedText(report) {
	const what = report.changed.length === 0 ? "" : `: ${report.changed.join(", ")}`;
	if (!report.settled) return `The page was still changing when this returned${what === "" ? "" : ` (changed${what})`}.`;
	if (what === "") return "The page did not change.";
	return `The page changed${what}.`;
}
/**
* One action result as text: what was acted on, where the page is, what changed.
* @param subject - the verb and element, e.g. `Clicked button "Send"`.
* @param report - what the action reported.
* @param tabs - the session's open pages.
* @returns the text block a tool result renders.
*/
function actionText(subject, report, tabs) {
	const title = report.title === "" ? "" : ` — ${JSON.stringify(report.title)}`;
	const recovered = report.recovered === true ? "\nThe element had been replaced by the page; it was found again by its role and name." : "";
	const covered = report.obstructed === void 0 ? "" : `\nThe click was received by ${describeElement(report.obstructed)}, which is over the element the ref named.`;
	return `${subject}.\nPage: ${report.url}${title}\n${changedText(report)}${covered}${recovered}\n\n${tabsText(tabs)}`;
}
/**
* One snapshot result as text: where in the page it was taken, the tree itself,
* and where the rest of it went when it was too large to return.
* @param value - the snapshot a tool produced.
* @returns the text block a tool result renders.
*/
function snapshotText(value) {
	const head = value.info === "" ? "" : `${value.info}\n\n`;
	const spilled = value.path === void 0 ? "" : `\n\nThe snapshot is too large to read here; the whole of it is in ${value.path}.${value.hint === void 0 ? "" : `\n${value.hint}`}`;
	return `${head}${value.text}${spilled}\n\n${tabsText(value.tabs)}`;
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
/** The reported shape of what an action did to the page. */
const ACTION_PROPERTIES = {
	url: {
		type: "string",
		required: true
	},
	title: {
		type: "string",
		required: true
	},
	changed: {
		type: "array",
		required: true,
		items: { type: "string" }
	},
	settled: {
		type: "boolean",
		required: true
	},
	mutations: {
		type: "integer",
		required: true
	},
	recovered: { type: "boolean" },
	element: {
		type: "object",
		additionalProperties: false,
		properties: {
			role: {
				type: "string",
				required: true
			},
			name: {
				type: "string",
				required: true
			}
		}
	},
	obstructed: {
		type: "object",
		additionalProperties: false,
		properties: {
			role: {
				type: "string",
				required: true
			},
			name: {
				type: "string",
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
	/** The harness spill store, when the composition mounts one. */
	const store = spillStoreOf(ctx);
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
					...ACTION_PROPERTIES,
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `${value.title}\n${value.url}\n${changedText(value)}\n\n${tabsText(value.tabs)}`
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			const report = await cancelable(browser, exec.signal, `opening ${args.url}`, () => browser.navigate(args.url));
			return {
				...report,
				changed: [...report.changed],
				tabs: [...browser.status().tabs]
			};
		},
		timeoutMs: NAVIGATE_TIMEOUT_MS
	})), "dsh-browser: browser_navigate");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_snapshot",
		description: "Read the current page as a tree of roles, names, and refs. Refs name elements for browser_click and browser_type and stay valid while the page is loaded. Narrow a large page with target or depth; write one too large to read to a file with file.",
		parameters: {
			target: {
				type: "string",
				description: "A ref from an earlier snapshot, or a CSS selector, to print only that element and what is inside it."
			},
			depth: {
				type: "integer",
				description: "Deepest level to print, counting the top of the tree as 0."
			},
			file: {
				type: "boolean",
				description: "Write the whole snapshot to a file and return its path, for a page too large to read inline."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					info: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					nodes: {
						type: "integer",
						required: true
					},
					path: { type: "string" },
					hint: { type: "string" },
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: snapshotText(value)
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			const snapshot = await cancelable(browser, exec.signal, "reading the page", () => browser.snapshot({
				...args.target === void 0 ? {} : { target: args.target },
				...args.depth === void 0 ? {} : { depth: args.depth }
			}));
			const info = formatPageInfo(snapshot.info);
			const tabs = [...browser.status().tabs];
			if (!shouldSpill(snapshot.text, args.file === true)) return {
				text: snapshot.text,
				info,
				truncated: snapshot.truncated,
				nodes: snapshot.nodes,
				tabs
			};
			const written = await writeText(snapshot.text, {
				dir: SNAP_DIR,
				toolName: "browser_snapshot",
				label: "snapshot",
				...exec.agent?.id === void 0 ? {} : { sessionId: exec.agent.id },
				callId: String(exec.callId),
				...store === void 0 ? {} : { store }
			});
			return {
				text: preview(snapshot.text),
				info,
				truncated: snapshot.truncated,
				nodes: snapshot.nodes,
				path: written.path,
				hint: written.hint,
				tabs
			};
		},
		timeoutMs: PAGE_TIMEOUT_MS
	})), "dsh-browser: browser_snapshot");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_click",
		description: "Click an element named by a ref from browser_snapshot, with real mouse events at the element's own position. Reports the element, the address the page ended on, whether the page changed, and what received the click when something was over it. A press the page says another element would receive is refused; pass force to send it anyway.",
		parameters: {
			ref: {
				type: "string",
				required: true,
				description: "Ref from a browser_snapshot of the current page, such as e3."
			},
			force: {
				type: "boolean",
				description: "Click even when the page says another element would receive the press, such as an overlay. What received it is then reported instead of refused."
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
					...ACTION_PROPERTIES,
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: actionText(`Clicked ${describeElement(value.element)}`, value, value.tabs)
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			const report = await cancelable(browser, exec.signal, `clicking ${args.ref}`, () => browser.click(args.ref, { ...args.force === void 0 ? {} : { force: args.force } }));
			return {
				ref: args.ref,
				...report,
				changed: [...report.changed],
				tabs: [...browser.status().tabs]
			};
		},
		timeoutMs: PAGE_TIMEOUT_MS
	})), "dsh-browser: browser_click");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_type",
		description: "Type text into an element named by a ref from browser_snapshot, replacing what the field holds. Pass a key such as Enter to submit after typing. An element the page says cannot take text — read-only, disabled, or not a text control — is refused instead of reported as typed into.",
		parameters: {
			ref: {
				type: "string",
				required: true,
				description: "Ref from a browser_snapshot of the current page, such as e3."
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
					},
					...ACTION_PROPERTIES,
					tabs: TABS_SCHEMA
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: actionText(`Typed ${JSON.stringify(value.text)} into ${describeElement(value.element)}`, value, value.tabs)
			}]
		},
		async execute(args, exec) {
			const browser = browserFor(pool, exec);
			const report = await cancelable(browser, exec.signal, `typing into ${args.ref}`, () => browser.type(args.ref, args.text, {
				...args.clear === void 0 ? {} : { clear: args.clear },
				...args.key === void 0 ? {} : { key: args.key }
			}));
			return {
				ref: args.ref,
				text: args.text,
				...report,
				changed: [...report.changed],
				tabs: [...browser.status().tabs]
			};
		},
		timeoutMs: PAGE_TIMEOUT_MS
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
			const browser = browserFor(pool, exec);
			const shot = await cancelable(browser, exec.signal, "capturing the page", () => browser.screenshot());
			await mkdir(SHOT_DIR, { recursive: true });
			const path = join(SHOT_DIR, `shot-${Date.now()}.jpg`);
			await writeFile(path, shot.jpeg);
			return {
				path,
				width: shot.width,
				height: shot.height,
				bytes: shot.jpeg.length
			};
		},
		timeoutMs: PAGE_TIMEOUT_MS
	})), "dsh-browser: browser_screenshot");
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "browser_evaluate",
		description: "Evaluate JavaScript in this conversation's browser page and return its value, awaiting it when it is a promise and calling it when it is a function. Top-level await is allowed. The general-purpose tool: use it to read values, scroll, wait for something, or go back in history.",
		parameters: { expression: {
			type: "string",
			required: true,
			description: "JavaScript to evaluate in the page; a returned promise is awaited and a returned function is called."
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
			const browser = browserFor(pool, exec);
			return { result: readable(await cancelable(browser, exec.signal, "evaluating in the page", () => browser.evaluate(args.expression))) };
		},
		timeoutMs: EVALUATE_TIMEOUT_MS
	})), "dsh-browser: browser_evaluate");
}
/**
* Name an element the way a snapshot line names it.
* @param element - the element an action reported, when it named one.
* @returns the element as role and quoted name, or a neutral stand-in.
*/
function describeElement(element) {
	if (element === void 0) return "the element";
	return `${element.role} ${JSON.stringify(element.name)}`;
}
//#endregion
//#region src/settings.ts
/**
* Declare this plugin's page policy and follow its volatile configuration.
* @param ctx - plugin context.
* @param resolve - reads the current values out of the configuration the loader holds.
* @param pool - the browsers that are reconfigured on every change.
*/
function installSettings(ctx, resolve, pool) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), "dsh-browser: settings page policy");
	});
	ctx.on("loader/volatile-update", () => {
		pool.reconfigure(resolve());
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
* @param config - the configuration the loader holds, whose editable fields it
* rewrites in place.
*/
function apply(ctx, config) {
	const resolve = () => plainConfig(config);
	const pool = new BrowserPool(resolve(), ctx.logger);
	ctx.effect(() => () => {
		pool.closeAll();
	}, "dsh-browser: browser lifetime");
	ctx.on("session/disposed", (session) => {
		pool.dispose(session.id);
	});
	installSettings(ctx, resolve, pool);
	registerStream(ctx, pool);
	registerStatus(ctx, pool);
	registerTools(ctx, pool);
}
//#endregion
export { Config, apply, inject, name, plainConfig };

//# sourceMappingURL=index.js.map