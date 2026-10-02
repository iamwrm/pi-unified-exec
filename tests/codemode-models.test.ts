import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodemodeExtension, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compactCodemodeDefinition } from "../src/codemode-render.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWioAAAAASUVORK5CYII=";
const imageModel = { type: "image", provider: "offline", id: "painter", name: "Painter", api: "fixture", input: ["text"] };
const classifier = { ...imageModel, type: "classifier", id: "judge" };
const usage = { input: 2, output: 3, totalTokens: 5, cost: { total: 0.125 } };
function fixture() {
	let definition!: ReturnType<typeof compactCodemodeDefinition>;
	createCodemodeExtension()({ registerTool: (value: ReturnType<typeof compactCodemodeDefinition>) => { definition = value; }, appendEntry() {}, getAllTools: () => [] } as unknown as ExtensionAPI);
	let dispatches = 0;
	const ctx = { tools: [], sessionManager: { getBranch: () => [] }, modelRegistry: {
		getModelsOfType: (type: string) => type === "image" ? [imageModel] : [classifier],
		getAvailableOfType: async () => [imageModel],
		getModelOfType: (type: string, provider: string, id: string) => provider === "offline" && (type === "image" && id === "painter" || type === "classifier" && id === "judge") ? type === "image" ? imageModel : classifier : undefined,
		generateImages: async () => { dispatches++; return { provider: "offline", model: "painter", output: [{ type: "image", data: png, mimeType: "image/png" }], usage, stopReason: "stop" }; },
		classify: async () => { dispatches++; return { provider: "offline", model: "judge", answers: {}, usage, stopReason: "stop" }; },
	} } as unknown as ExtensionToolContext;
	return { definition, wrapped: compactCodemodeDefinition(definition), ctx, dispatches: () => dispatches };
}
const script = `
const painter = await models.getModelOfType("image", "offline", "painter");
const result = await models.generateImages(painter, { input: [{ type: "text", text: "one pixel" }] });
for (const block of result.output) image(block);
const judge = await models.getModelOfType("classifier", "offline", "judge");
await models.classify(judge, { state: {}, questions: { ok: { type: "bool", instructions: "fixture", criteria: { true: "yes", false: "no" } } } });
text({unknownTool: "absent" in tools, unknownModel: "absent" in models});`;
const textOf = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("native and wrapped codemode preserve generated image blocks and model usage exactly once", async () => {
	for (const fixed of [false, true]) {
		const f = fixture();
		const result = await (fixed ? f.wrapped : f.definition).execute("models", { code: script }, undefined, undefined, f.ctx);
		assert.match(textOf(result), /Script completed/);
		assert.doesNotMatch(textOf(result), /returned .* image.*did not show/);
		assert.deepEqual(result.content.filter(block => block.type === "image"), [{ type: "image", data: png, mimeType: "image/png" }]);
		assert.equal(result.usage?.input, 4);
		assert.equal(result.usage?.output, 6);
		assert.equal(result.usage?.totalTokens, 10);
		assert.equal(result.usage?.cost.total, 0.25);
		assert.equal(f.dispatches(), 2);
	}
});

for (const member of ["tools.absent", "models.absent"]) test(`native codemode unknown member ${member} fails without dispatch`, async () => {
	const f = fixture();
	const result = await f.wrapped.execute("unknown", { code: `text(${member});` }, undefined, undefined, f.ctx);
	assert.match(textOf(result), /Script failed/);
	assert.match(textOf(result), /absent/);
	assert.equal(f.dispatches(), 0);
});
