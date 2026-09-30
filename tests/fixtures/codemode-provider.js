// Offline codemode fixture shared by actual-CLI and real-TUI regressions.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

const output = Array.from({ length: 40 }, (_, i) => `line of build output number ${i + 1}`).join("\n") + "\n";
const command = "seq 1 40 | sed 's/^/line of build output number /'";
const exec = `await tools.exec_command({cmd: ${JSON.stringify(command)}, yield_time_ms: 5000})`;
const scripts = {
	A: [`const r = ${exec};\ntext(r);`],
	B: [`const s = await Promise.allSettled([${exec}]);\ntext({i: 0, ...s[0]});`],
	C: [`const r = ${exec};\ntext(\`exit \${r.exit_code}\`);\ntext(r.output);`],
	spill: ['// @options: {"max_output_tokens": 100}\nconst r = await tools.sample({}); text(r);'],
	parity: [
		'const r = await tools.sample({}); store("probe", r); text(r);',
		'text({loaded: load("probe"), declared: await describeTool("sample"), found: await searchTools("sample")}); store("remove", true);',
		'store("remove", undefined); text(load("probe").output); text({remove: load("remove"), models: (await models.getModelsOfType("chat", "exec-codemode-offline")).map(m => m.id)});',
	],
	mcp: ['const r = await tools.mcp__fixture__echo({}); text(r);'],
	inactive: [],
};

function currentTools(messages) {
	const tools = new Map();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

export default function (pi) {
	pi.registerTool({
		name: "sample", label: "sample", description: "Sample build output fixture", exposure: "codemode",
		parameters: Type.Object({}),
		outputSchema: Type.Object({ status: Type.String(), exit_code: Type.Number(), output: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: output }], details: {}, structuredContent: { status: "exited", exit_code: 0, output } };
		},
	});
	if (process.env.EXEC_CODEMODE_MCP) {
		pi.registerMcpServer("fixture", { command: process.execPath, args: [process.env.EXEC_CODEMODE_MCP], exposure: "codemode" });
	}
	const capture = context => {
		if (process.env.EXEC_CODEMODE_CAPTURE) appendFileSync(process.env.EXEC_CODEMODE_CAPTURE, JSON.stringify({ tools: currentTools(context.messages) }) + "\n");
	};
	const faux = fauxProvider({ provider: "exec-codemode-offline", models: [{ id: "codemode-model" }], tokensPerSecond: 100000 });
	const selected = scripts[process.env.EXEC_CODEMODE_PATTERN ?? "A"];
	if (!selected) throw new Error("Unknown codemode fixture pattern");
	faux.setResponses([
		...selected.map(code => context => { capture(context); return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }); }),
		context => { capture(context); return fauxAssistantMessage("EXEC_CODEMODE_OK"); },
	]);
	pi.registerProvider(faux.provider);
}
