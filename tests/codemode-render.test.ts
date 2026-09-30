import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodemodeExtension, initTheme, type AgentToolResult, type CodemodeToolDetails, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CODEMODE_PREVIEW_ROWS, COMPACT_CODEMODE_ENV, compactCodemodeDefinition, defaultToolsWantCodemode, registerCompactCodemode } from "../src/codemode-render.ts";

// Native codemode's physical TUI dependency owns keyHint's global bindings.
// Pi's real extension loader aliases these instances; standalone tests must too.
const require = createRequire(import.meta.url);
const nativeTui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui", {
	paths: [fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url))],
})).href);
initTheme("dark", false);
nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
const theme = { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
type Definition = ReturnType<typeof compactCodemodeDefinition>;
type ToolRenderContext = Parameters<NonNullable<Definition["renderResult"]>>[3];
let original!: Definition;
createCodemodeExtension()({ registerTool: (def: Definition) => { original = def; } } as unknown as ExtensionAPI);
const wrapped = compactCodemodeDefinition(original);
const output = Array.from({ length: 40 }, (_, i) => `line of build output number ${i + 1}`).join("\n") + "\n";
const context = (extra: Partial<ToolRenderContext> = {}): ToolRenderContext => ({
	args: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/tmp",
	executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false, ...extra,
});
const resultOf = (text: string, details: CodemodeToolDetails = { calls: [] }): AgentToolResult<CodemodeToolDetails | undefined> => ({
	content: [{ type: "text", text: "Script completed\nWall time 0.001 seconds\nOutput:\n" }, { type: "text", text }], details,
});
const options = { expanded: false, isPartial: false };
function bounded(result: ReturnType<typeof resultOf>, width: number) {
	const component = wrapped.renderResult!(result, options, theme, context());
	const rows = component.render(width);
	assert.ok(rows.length <= CODEMODE_PREVIEW_ROWS, `${rows.length} rows: ${rows.join("\n")}`);
	for (const row of rows) assert.ok(visibleWidth(row) <= width);
	return { component, rows };
}

for (const width of [20, 40, 80, 100]) {
	test(`codemode object and settled JSON bounded at width ${width}`, () => {
		for (const text of [JSON.stringify({ status: "exited", output, exit_code: 0 }), JSON.stringify({ i: 0, status: "fulfilled", value: { output } })]) {
			const result = resultOf(text);
			assert.ok(original.renderResult!(result, options, theme, context()).render(width).length > CODEMODE_PREVIEW_ROWS);
			const { rows } = bounded(result, width);
			assert.match(rows.at(-1)!, width >= 40 ? /clipped/ : /ctrl\+o/);
			assert.doesNotMatch(rows.at(-1)!, /\d+ more rows/);
		}
	});
	test(`codemode ANSI and wide Unicode bounded at width ${width}`, () => {
		bounded(resultOf("\x1b[31m" + "中文🙂".repeat(500) + "\x1b[0m"), width);
	});
	test(`codemode native logical-line hint preserved at width ${width}`, () => {
		const result = resultOf("exit 0\n" + output);
		const nativeRows = original.renderResult!(result, options, theme, context()).render(width);
		const { rows } = bounded(result, width);
		if (nativeRows.length <= CODEMODE_PREVIEW_ROWS) assert.deepEqual(rows, nativeRows);
		else assert.match(rows.at(-1)!, width >= 40 ? /clipped/ : /ctrl\+o/);
		assert.equal(rows.filter(row => /ctrl\+o/.test(row)).length, 1);
	});
	test(`codemode spill recovery footer visible at width ${width}`, () => {
		const result = resultOf(JSON.stringify({ output }) + "\n\n[Full output: /tmp/pi-codemode-1234abcd.txt (read with offset/limit)]", { calls: [], fullOutputPath: "/tmp/pi-codemode-1234abcd.txt" });
		const { rows } = bounded(result, width);
		assert.match(rows.at(-1)!, /^Full output:/);
		assert.match(rows.at(-2)!, width >= 40 ? /clipped/ : /ctrl\+o/);
	});
}

test("codemode keeps every native field except renderResult by reference", () => {
	for (const key of Object.keys(original) as (keyof Definition)[]) {
		if (key !== "renderResult") assert.equal(wrapped[key], original[key], key);
	}
	assert.equal(wrapped.defaultActive, false);
	assert.equal(wrapped.exposure, "model-only");
});

test("codemode missing native renderer degrades to the native definition", () => {
	const native = { ...original, renderResult: undefined };
	assert.equal(compactCodemodeDefinition(native), native);
});

test("codemode partial -> final -> redraw -> expand -> collapse preserves native cache", () => {
	const call = { id: "test/0", name: "read", args: '{"path":"file.md"}', status: "running" as const };
	let component = wrapped.renderResult!({ content: [], details: { calls: [call] } }, { ...options, isPartial: true }, theme, context({ isPartial: true }));
	component.render(40);
	const result = resultOf(JSON.stringify({ output }), { calls: [{ ...call, status: "ok" }] });
	for (const expanded of [false, false, true, true, false, false]) {
		component.invalidate();
		component = wrapped.renderResult!(result, { ...options, expanded }, theme, context({ lastComponent: component, expanded }));
		const rows = component.render(40);
		if (!expanded) assert.ok(rows.length <= CODEMODE_PREVIEW_ROWS);
		else {
			assert.deepEqual(rows, original.renderResult!(result, { ...options, expanded: true }, theme, context({ expanded: true })).render(40));
			assert.match(rows.join(""), /number 40/);
		}
	}
});

test("codemode many nested calls, errors and partial updates stay bounded", () => {
	for (const isPartial of [true, false]) {
		const calls = Array.from({ length: 30 }, (_, i) => ({ id: `test/${i}`, name: "read", args: JSON.stringify({ path: "x".repeat(200) }), status: i === 29 ? "error" as const : "ok" as const, error: "ERR" }));
		const component = wrapped.renderResult!(resultOf(JSON.stringify({ output }), { calls }), { expanded: false, isPartial }, theme, context({ isPartial, isError: true }));
		assert.ok(component.render(40).length <= CODEMODE_PREVIEW_ROWS);
	}
});

test("codemode renderer never changes model content or details", () => {
	const result = resultOf(JSON.stringify({ output }));
	const before = structuredClone(result);
	Object.freeze(result.content[0]); Object.freeze(result.content[1]); Object.freeze(result.content);
	Object.freeze(result.details!.calls); Object.freeze(result.details); Object.freeze(result);
	const { component } = bounded(result, 40);
	wrapped.renderResult!(result, { ...options, expanded: true }, theme, context({ lastComponent: component, expanded: true })).render(40);
	assert.deepEqual(result, before);
});

test("codemode clipping handles zero width and configured expansion keys", () => {
	assert.deepEqual(bounded(resultOf(JSON.stringify({ output })), 0).rows, []);
	nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+k" } }));
	try { assert.match(bounded(resultOf(JSON.stringify({ output })), 80).rows.at(-1)!, /ctrl\+k/); }
	finally { nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } })); }
});

type Start = (event: unknown, ctx: unknown) => Promise<void>;
/** Fake Pi API: registry ownership mirrors `getAllTools().sourceInfo`. */
function fakePi(owner = "unified-exec") {
	const tools: Definition[] = [];
	const starts: Start[] = [];
	const notes: string[] = [];
	const pi = {
		registerTool(definition: Definition) { assert.equal(this, pi); tools.push(definition); },
		getSettings() { assert.equal(this, pi); return { codemode: { mode: "only", inlineBudget: 0 } }; },
		getAllTools() {
			return [{ name: "exec_command", sourceInfo: { path: "unified-exec" } }, ...(tools.length ? [{ name: "codemode", sourceInfo: { path: owner } }] : [])];
		},
		appendEntry() { assert.equal(this, pi); },
		getActiveTools: () => ["exec_command"],
		setActiveTools() { assert.fail("builtin codemode was shadowed; defaultTools already applied"); },
		on(event: string, handler: Start) { assert.equal(event, "session_start"); starts.push(handler); },
	};
	const start = async (hasUI = true) => {
		for (const handler of starts) await handler({}, { hasUI, ui: { notify: (text: string) => notes.push(text) } });
	};
	return { api: pi as unknown as ExtensionAPI, tools, notes, start };
}

test("codemode native factory forwards API receivers and preserves schema identity", async () => {
	const pi = fakePi();
	registerCompactCodemode(pi.api, {});
	await pi.start();
	assert.equal(pi.tools.length, 1);
	assert.equal(pi.tools[0].parameters, original.parameters);
	assert.equal(pi.tools[0].defaultActive, false);
	const changes = pi.tools[0].prepareLoadout!({ declared: [], callable: [], registered: [], getExposure() { return "direct"; }, getNamespace() { return undefined; } });
	assert.match(changes!.descriptions!.codemode, /getModelsOfType\(/);
	assert.deepEqual(pi.notes, []);
});

test("codemode fix registers once at session start, with only an environment opt-out", async () => {
	for (const value of [undefined, "1", "0"]) {
		const pi = fakePi();
		registerCompactCodemode(pi.api, { [COMPACT_CODEMODE_ENV]: value });
		// Registering during load would make Pi skip builtin:codemode and warn.
		assert.equal(pi.tools.length, 0);
		await pi.start();
		await pi.start(); // new/resume/fork reuse the extension instance
		assert.equal(pi.tools.length, value === "0" ? 0 : 1);
	}
});

test("codemode fix reports lost precedence instead of claiming to be active", async () => {
	const pi = fakePi("builtin:codemode");
	registerCompactCodemode(pi.api, {});
	await pi.start();
	assert.equal(pi.notes.length, 1);
	assert.match(pi.notes[0], /builtin:codemode takes precedence; compact codemode previews are off/);
	const quiet = fakePi("builtin:codemode");
	registerCompactCodemode(quiet.api, {});
	await quiet.start(false);
	assert.deepEqual(quiet.notes, []);
});

test("codemode defaultTools rule follows the last entry naming codemode", () => {
	assert.equal(defaultToolsWantCodemode(undefined), false);
	assert.equal(defaultToolsWantCodemode(["+codemode"]), true);
	assert.equal(defaultToolsWantCodemode(["read", "codemode"]), true);
	assert.equal(defaultToolsWantCodemode(["+codemode", "-codemode"]), false);
	assert.equal(defaultToolsWantCodemode(["-codemode", "+codemode"]), true);
	assert.equal(defaultToolsWantCodemode(["+tool_search"]), false);
});

test("codemode fix applies defaultTools only when no built-in codemode was shadowed", async () => {
	for (const [builtin, defaultTools, activated] of [[false, ["+codemode"], true], [true, ["+codemode"], false], [false, [], false]] as const) {
		const tools: Definition[] = [];
		const starts: Start[] = [];
		let active = ["read", "exec_command"];
		const sets: string[][] = [];
		const pi = {
			registerTool(definition: Definition) { tools.push(definition); },
			getSettings: () => ({ defaultTools }),
			getAllTools: () => [{ name: "exec_command", sourceInfo: { path: "unified-exec" } },
				...(builtin || tools.length ? [{ name: "codemode", sourceInfo: { path: tools.length ? "unified-exec" : "builtin:codemode" } }] : [])],
			getActiveTools: () => active,
			setActiveTools(names: string[]) { sets.push(names); active = names; },
			appendEntry() {},
			on(_event: string, handler: Start) { starts.push(handler); },
		};
		registerCompactCodemode(pi as unknown as ExtensionAPI, {});
		for (const handler of starts) await handler({}, { hasUI: false, ui: {} });
		assert.deepEqual(sets, activated ? [["read", "exec_command", "codemode"]] : [], `${builtin} ${defaultTools}`);
	}
});
