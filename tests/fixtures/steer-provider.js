import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";

/**
 * Local scripted provider for the steer-interrupt CLI test. No credentials,
 * HTTP, or paid model requests. Turn 1 starts a 30 s job, turn 2 attaches a
 * 900 s empty poll, turn 3 must see the human steer next to the early result.
 */
export default function (pi) {
	const faux = fauxProvider({ provider: "exec-steer-offline", models: [{ id: "steer-model" }] });
	const text = (message) => typeof message.content === "string" ? message.content
		: message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
	let requests = 0;
	faux.setResponses(Array.from({ length: 8 }, () => (context) => {
		requests++;
		if (requests === 1) {
			return fauxAssistantMessage(fauxToolCall("exec_command", {
				cmd: "node job.cjs", yield_time_ms: 250,
			}), { stopReason: "toolUse" });
		}
		if (requests === 2) {
			const result = context.messages.findLast((m) => m.role === "toolResult" && m.toolName === "exec_command");
			const match = /^session_id: (\d+)/m.exec(result ? text(result) : "");
			if (!match) throw new Error("Expected a running session");
			return fauxAssistantMessage(fauxToolCall("write_stdin", {
				session_id: Number(match[1]), yield_time_ms: 900_000,
			}), { stopReason: "toolUse" });
		}
		const last = context.messages.at(-1);
		const poll = context.messages.findLast((m) => m.role === "toolResult" && m.toolName === "write_stdin");
		const steered = last?.role === "user" && /STEER-TEST-4821/.test(text(last))
			&& poll && /wait_status: interrupted_by_steer/.test(text(poll));
		return fauxAssistantMessage(steered ? "STEER_SEEN" : "STEER_MISSING");
	}));
	pi.registerProvider(faux.provider);
}
