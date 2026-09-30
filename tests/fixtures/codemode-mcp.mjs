// Minimal, entirely local MCP fixture; no network or provider credentials.
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", line => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result;
	switch (request.method) {
		case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "codemode-fixture", version: "1.0.0" } }; break;
		case "tools/list": result = { tools: [{ name: "echo", description: "Offline echo", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }; break;
		case "tools/call": result = { content: [{ type: "text", text: "MCP_OK" }] }; break;
		case "ping": result = {}; break;
		default: process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n"); return;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
