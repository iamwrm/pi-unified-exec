/**
 * Codemode script-facing results: every tool declares an `outputSchema` and
 * returns a matching `structuredContent`, so codemode scripts receive
 * `output` as a real multi-line string instead of the whole text envelope.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, initTheme } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import extensionFactory from "../src/index.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResultSchema,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResultSchema,
} from "../src/script-result.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { finalizeKillResult, finalizeProcessResult, renderProcessResultText } from "../src/tool-result.ts";

const encoder = new TextEncoder();

function assertPlainJson(value: unknown): void {
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "structuredContent must be plain JSON");
}

function processInput(overrides: Partial<Parameters<typeof finalizeProcessResult>[0]> = {}) {
	return {
		operation: "exec_command" as const,
		wallTimeSec: 0.25,
		collected: encoder.encode("hello\nworld\n"),
		sessionId: undefined,
		exitCode: 0,
		signal: null,
		failure: null,
		tty: false,
		logPath: "/tmp/session.log",
		...overrides,
	};
}

function makeHarness() {
	const tools: Record<string, any> = {};
	const ctx = {
		cwd: process.cwd(),
		ui: { notify() {}, setStatus() {}, setWidget() {}, select: async () => undefined },
		hasUI: false,
	};
	(extensionFactory as any)({
		registerTool: (def: any) => (tools[def.name] = def),
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		registerMessageRenderer() {},
		getFlag: () => false,
		getActiveTools: () => [],
		setActiveTools() {},
	});
	return {
		tools,
		call: (name: string, params: any) => tools[name].execute("test-call-id", params, undefined, undefined, ctx),
	};
}

describe("script result projections", () => {
	it("exited process: real newlines, exit code, schema-valid plain JSON", () => {
		const details = finalizeProcessResult(processInput());
		const value = processScriptResult(details);
		assert.ok(Value.Check(processScriptResultSchema, value));
		assertPlainJson(value);
		assert.equal(value.status, "exited");
		assert.equal(value.running, false);
		assert.equal(value.exit_code, 0);
		assert.equal(value.output, "hello\nworld\n");
		assert.equal(value.truncated, false);
		assert.equal(value.session_id, undefined);
	});

	it("running process exposes session_id; non-zero exit and signal are typed", () => {
		const running = processScriptResult(finalizeProcessResult(processInput({ sessionId: 3, exitCode: undefined })));
		assert.ok(Value.Check(processScriptResultSchema, running));
		assert.equal(running.status, "running");
		assert.equal(running.session_id, 3);
		assert.equal(running.exit_code, undefined);

		const failed = processScriptResult(
			finalizeProcessResult(processInput({ exitCode: 2, signal: "SIGTERM", failure: "boom\nsecond line" })),
		);
		assert.ok(Value.Check(processScriptResultSchema, failed));
		assert.equal(failed.exit_code, 2);
		assert.equal(failed.signal, "SIGTERM");
		assert.equal(failed.failure_message, "boom second line", "metadata stays single-line and bounded");
	});

	it("truncated output stays within Pi's byte cap and is flagged", () => {
		const big = "x".repeat(DEFAULT_MAX_BYTES * 2);
		const value = processScriptResult(finalizeProcessResult(processInput({ collected: encoder.encode(big) })));
		assert.ok(Value.Check(processScriptResultSchema, value));
		assert.equal(value.truncated, true);
		assert.ok(Buffer.byteLength(value.output) <= DEFAULT_MAX_BYTES);
	});

	it("terminal control sequences never reach script output", () => {
		const value = processScriptResult(
			finalizeProcessResult(processInput({ collected: encoder.encode("\u001b[31mred\u001b[0m\u0007 ok\n") })),
		);
		assert.doesNotMatch(value.output, /\u001b|\u0007/);
		assert.match(value.output, /red ok/);
	});

	it("kill results, including failed and unknown sessions, match the kill schema", () => {
		const killInput = {
			wallTimeSec: 0.1,
			collected: encoder.encode("bye\n"),
			sessionId: 4,
			pid: 1234,
			requestedSignal: "SIGTERM" as NodeJS.Signals,
			exitCode: undefined,
			signal: "SIGTERM" as NodeJS.Signals,
			failure: null,
			tty: false,
			escalated: false,
			killed: true,
		};
		const killed = killScriptResult(finalizeKillResult(killInput));
		assert.ok(Value.Check(killScriptResultSchema, killed));
		assert.equal(killed.status, "killed");
		assert.equal(killed.output, "bye\n");

		const failed = killScriptResult(finalizeKillResult({ ...killInput, killed: false, failure: "still alive" }));
		assert.ok(Value.Check(killScriptResultSchema, failed));
		assert.equal(failed.status, "kill_failed");
		assert.equal(failed.running, true);

		const missing = killNotFoundScriptResult(99);
		assert.ok(Value.Check(killScriptResultSchema, missing));
		assert.equal(missing.found, false);
	});
});

describe("registered tools return structuredContent", { skip: IS_WINDOWS }, () => {
	it("every tool declares an outputSchema", () => {
		const { tools } = makeHarness();
		for (const name of ["exec_command", "write_stdin", "kill_session", "list_sessions", "set_on_exit"]) {
			assert.ok(tools[name]?.outputSchema, `${name} must declare outputSchema`);
		}
	});

	it("exec_command keeps model content unchanged and mirrors details.output", async () => {
		const { call } = makeHarness();
		const result = await call("exec_command", { cmd: "printf 'a\\nb\\n'; exit 3", yield_time_ms: 5000 });
		assert.equal(result.content[0].text, renderProcessResultText(result.details));
		assert.ok(Value.Check(processScriptResultSchema, result.structuredContent));
		assertPlainJson(result.structuredContent);
		assert.equal(result.structuredContent.output, result.details.output);
		assert.equal(result.structuredContent.output, "a\nb\n");
		assert.equal(result.structuredContent.exit_code, 3);
	});

	it("write_stdin, list_sessions, set_on_exit and kill_session cover live and unknown sessions", async () => {
		const { call } = makeHarness();
		const started = await call("exec_command", { cmd: "echo ready; sleep 30", yield_time_ms: 300 });
		const sid = started.structuredContent.session_id;
		assert.equal(typeof sid, "number");
		assert.equal(started.structuredContent.status, "running");

		const polled = await call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.ok(Value.Check(processScriptResultSchema, polled.structuredContent));
		assert.equal(polled.structuredContent.running, true);

		const listed = await call("list_sessions", {});
		assert.ok(Value.Check(listSessionsScriptResultSchema, listed.structuredContent));
		assertPlainJson(listed.structuredContent);
		assert.ok(listed.structuredContent.sessions.some((s: any) => s.session_id === sid && s.running));

		const armed = await call("set_on_exit", { session_id: sid, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, armed.structuredContent));
		assert.equal(armed.structuredContent.wake_armed, true);
		const unknownOnExit = await call("set_on_exit", { session_id: 999_999, on_exit: "wake" });
		assert.ok(Value.Check(setOnExitScriptResultSchema, unknownOnExit.structuredContent));
		assert.equal(unknownOnExit.structuredContent.found, false);

		const killed = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, killed.structuredContent));
		assert.equal(killed.structuredContent.status, "killed");
		const unknownKill = await call("kill_session", { session_id: sid });
		assert.ok(Value.Check(killScriptResultSchema, unknownKill.structuredContent));
		assert.equal(unknownKill.structuredContent.found, false);
	});
});

describe("actual Pi codemode", { skip: IS_WINDOWS }, () => {
	it("scripts receive an object whose output renders as bounded real lines", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-unified-exec-codemode-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			const script = [
				'const r = await tools.exec_command({ cmd: "seq 1 40 | sed \'s/^/line of build output number /\'", yield_time_ms: 5000 });',
				'const decl = await describeTool("exec_command");',
				'text(JSON.stringify({ type: typeof r, exit_code: r.exit_code, lines: r.output.trimEnd().split("\\n").length, declared: /output: string/.test(JSON.stringify(decl)) }));',
				"text(r.output);",
			].join("\n");
			const provider = join(root, "provider.ts");
			writeFileSync(
				provider,
				`
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
export default function(pi) {
  const faux = fauxProvider({ provider: 'exec-codemode' });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: ${JSON.stringify(script)} }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('CODEMODE_OK'),
  ]);
  pi.registerProvider(faux.provider);
}
`,
			);
			const cli =
				process.env.PI_UNIFIED_EXEC_TEST_CLI ??
				fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
			const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
			// prettier-ignore
			const run = spawnSync(process.execPath, [
				// No --no-extensions: codemode is a built-in extension. HOME and the agent dir are isolated.
				cli, "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes",
				"-e", provider, "-e", extension, "--tools", "codemode,exec_command", "--provider", "exec-codemode", "--model", "faux-1", "run it",
			], {
				cwd: root,
				env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 8 * 1024 * 1024,
			});
			assert.equal(run.error, undefined);
			assert.equal(run.status, 0, run.stderr);
			const rows = run.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line));
			const end = rows.find((row) => row.type === "tool_execution_end" && row.toolName === "codemode");
			assert.ok(end, run.stdout.slice(-8000));
			assert.equal(end.isError, false, JSON.stringify(end.result).slice(0, 4000));
			const texts: string[] = end.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text);
			const summaryText = texts.find((t) => t.startsWith('{"type"'));
			assert.ok(summaryText, texts.join("\n---\n"));
			assert.deepEqual(JSON.parse(summaryText), { type: "object", exit_code: 0, lines: 40, declared: true });
			assert.match(run.stdout, /CODEMODE_OK/);

			// Pi's own codemode renderer, collapsed at width 80: real lines are
			// bounded by its five-line preview (22 rows before this change).
			const { codemodeRenderers } = await import(
				"../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js"
			);
			initTheme("dark", false);
			const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t };
			const renderResult = codemodeRenderers.renderResult as (...args: unknown[]) => { render(width: number): string[] };
			const component = renderResult(
				{ ...end.result, details: undefined },
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false, showImages: false },
			);
			const rendered: string[] = component.render(80);
			assert.ok(rendered.length <= 8, `collapsed codemode rows: ${rendered.length}\n${rendered.join("\n")}`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
