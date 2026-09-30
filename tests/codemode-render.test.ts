import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCodemodeExtension, initTheme, type AgentToolResult, type CodemodeToolDetails, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CODEMODE_PREVIEW_ROWS, COMPACT_CODEMODE_ENV, compactCodemodeDefinition, registerCompactCodemode } from "../src/codemode-render.ts";

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

test("codemode missing native renderer fails activation clearly", () => {
	assert.throws(() => compactCodemodeDefinition({ ...original, renderResult: undefined }), /native codemode result renderer missing/);
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

test("codemode native factory forwards API receivers and preserves schema identity", async () => {
	const tools: Definition[] = [];
	const pi = {
		registerTool(definition: Definition) { assert.equal(this, pi); tools.push(definition); },
		getSettings() { assert.equal(this, pi); return { codemode: { mode: "only", inlineBudget: 0 } }; },
		getAllTools() { assert.equal(this, pi); return []; },
		appendEntry() { assert.equal(this, pi); },
	};
	await registerCompactCodemode(pi as unknown as ExtensionAPI, {});
	assert.equal(tools.length, 1);
	assert.equal(tools[0].parameters, original.parameters);
	assert.equal(tools[0].defaultActive, false);
	const changes = tools[0].prepareLoadout!({ declared: [], callable: [], registered: [], getExposure() { return "direct"; }, getNamespace() { return undefined; } });
	assert.match(changes!.descriptions!.codemode, /getModelsOfType\(/);
});

test("codemode fix is default-on with only an explicit environment opt-out", async () => {
	for (const value of [undefined, "1", "0"]) {
		const tools: Definition[] = [];
		await registerCompactCodemode({ registerTool(definition: Definition) { tools.push(definition); } } as unknown as ExtensionAPI, { [COMPACT_CODEMODE_ENV]: value });
		assert.equal(tools.length, value === "0" ? 0 : 1);
	}
});
