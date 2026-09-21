import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../src/index.ts";

for (const keep of [false, true]) {
	test(`current registered flag name controls builtin bash: ${keep}`, async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const lookups: string[] = [];
		let active = ["bash", "read", "exec_command"];
		activate({
			registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { handlers.set(name, handler); },
			getFlag: (name: string) => { lookups.push(name); assert.equal(name, "keep-builtin-bash"); return keep; },
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => { active = names; },
		} as unknown as ExtensionAPI);
		let widgetReads = 0;
		const ctx = { mode: "print", hasUI: false, ui: {
			setStatus: () => {},
			get setWidget() { widgetReads++; return () => {}; },
		} } as unknown as ExtensionContext;
		await handlers.get("session_start")?.({}, ctx);
		assert.deepEqual(lookups, ["keep-builtin-bash"]);
		assert.equal(widgetReads, 0, "no widget work or legacy capability probes with no sessions");
		assert.deepEqual(active, keep ? ["bash", "read", "exec_command"] : ["read", "exec_command"]);
		assert.ok(handlers.has("agent_settled"));
		assert.equal(handlers.has("agent_end"), false);
		await handlers.get("session_shutdown")?.({}, ctx);
	});
}

test("a rejected settled registration fails activation rather than selecting a legacy fallback", () => {
	assert.throws(() => activate({
		registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {},
		on: (event: string) => { if (event === "agent_settled") throw new Error("registration rejected"); },
	} as unknown as ExtensionAPI), /registration rejected/);
});
