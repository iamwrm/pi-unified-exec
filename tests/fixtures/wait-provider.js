import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

/** Local scripted provider only. No credentials, HTTP, or paid model requests. */
export default function (pi) {
	const scenario = process.env.EXEC_WAIT_SCENARIO ?? "streaming";
	const record = (value) => appendFileSync(join(process.cwd(), "events.jsonl"), `${JSON.stringify(value)}\n`);
	const faux = fauxProvider({
		provider: "exec-wait-offline",
		models: [{
			id: "wait-model",
			cost: scenario === "cheap"
				? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
				: { input: 1000, output: 1, cacheRead: 1, cacheWrite: 1000 },
		}],
	});
	// A synthetic 12-second TTL schedules a refresh after two seconds.
	// This exercises Pi's real timers without a five-minute test.
	if (scenario !== "no-ttl") faux.models[0].promptCache = { short: 12 };
	let waitActive = false;
	let realRequests = 0;
	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "write_stdin") {
			waitActive = true;
			record({ type: "wait-start" });
		}
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "write_stdin") {
			waitActive = false;
			record({ type: "wait-end", isError: event.isError, details: event.result.details });
		}
	});
	pi.on("cache_warming_decision", (event, ctx) => {
		record({ type: "decision", action: event.action, waitActive, idle: ctx.isIdle() });
		if (scenario === "veto") return { action: "stop" };
	});
	faux.setResponses(Array.from({ length: 32 }, () => (context, options) => {
		if (options?.maxTokens === 1) {
			record({ type: "warm", waitActive });
			return fauxAssistantMessage("warm");
		}
		realRequests++;
		if (realRequests === 1) {
			return fauxAssistantMessage(fauxToolCall("exec_command", {
				cmd: "node job.cjs", yield_time_ms: 250,
			}), { stopReason: "toolUse" });
		}
		if (realRequests === 2) {
			const result = context.messages.find(m => m.role === "toolResult" && m.toolName === "exec_command");
			const text = result?.role === "toolResult"
				? result.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
			const match = /^session_id: (\d+)/m.exec(text);
			if (!match) throw new Error(`Expected a running session: ${text}`);
			return fauxAssistantMessage(fauxToolCall("write_stdin", {
				session_id: Number(match[1]), yield_time_ms: 900_000,
			}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("EXEC_WAIT_OK");
	}));
	pi.registerProvider(faux.provider);
}
