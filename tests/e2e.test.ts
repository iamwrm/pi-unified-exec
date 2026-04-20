/**
 * End-to-end tests for unified-exec.
 *
 * Exercises the full tool pipeline by instantiating the extension with a stub
 * ExtensionAPI and calling the registered tools' `execute` functions directly.
 * Bypasses pi's event loop but uses the real SessionStore / ExecSession /
 * SpawnedChild code paths.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (_m: string) => {},
			setStatus: (_k: string, _v: unknown) => {},
		},
		hasUI: false,
	};

	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};

	// run the factory synchronously
	(extensionFactory as any)(pi);

	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, undefined, stubCtx);
		},
		stubCtx,
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	};
}

describe("unified-exec e2e", () => {
	it("short-lived command returns exit_code and no session_id", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello && echo world" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		assert.ok(r.details.output.includes("hello"));
		assert.ok(r.details.output.includes("world"));
		await h.emit("session_shutdown");
	});

	it("process that exits BETWEEN calls is still drainable via write_stdin", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 3 ticks @ 200ms = 600ms runtime. Yield at 250ms -> session_id returned.
		// Then wait 800ms so the process exits, then poll.
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3; do echo tock $i; sleep 0.2; done",
			yield_time_ms: 250,
		});
		assert.ok(
			typeof r1.details.session_id === "number",
			`first yield should return session_id; got ${JSON.stringify(r1.details)}`,
		);
		const sid = r1.details.session_id;

		// Wait for the process to definitely exit (600ms runtime - 250ms yield + slack).
		await new Promise((r) => setTimeout(r, 800));

		// Now poll — process has already exited, but the store should still have
		// the entry so we can observe the exit and drain trailing output.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `expected exit_code=0; got ${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		assert.ok(r2.details.output.includes("tock 3"), `expected 'tock 3' in output: ${r2.details.output}`);
		await h.emit("session_shutdown");
	});

	it("long-running command yields session_id and write_stdin resumes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 5 ticks, 0.3s apart = ~1.5s total. Yield at 600ms.
		const r1 = await h.call("exec_command", {
			cmd: "for i in 1 2 3 4 5; do echo tick $i; sleep 0.3; done",
			yield_time_ms: 600,
		});
		assert.equal(r1.details.exit_code, undefined, "should still be running");
		assert.ok(typeof r1.details.session_id === "number", `got session_id=${r1.details.session_id}`);
		const sid = r1.details.session_id;
		// Expect ~ticks 1-2 in first yield.
		assert.ok(r1.details.output.includes("tick 1"), `first out: ${r1.details.output}`);

		// Poll with big yield to catch the rest + exit.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "",
			yield_time_ms: 5000,
		});
		assert.equal(r2.details.exit_code, 0, `r2=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		assert.ok(r2.details.output.includes("tick 5"), `second out: ${r2.details.output}`);
		await h.emit("session_shutdown");
	});

	it("write_stdin sends input to a stdin consumer in pipe mode", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// cat prints back whatever you feed it on stdin. Pipe mode keeps stdin open.
		const r1 = await h.call("exec_command", {
			cmd: "cat",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
		const sid = r1.details.session_id;

		// Send a line.
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "hello from stdin\n",
			yield_time_ms: 400,
		});
		assert.ok(r2.details.output.includes("hello from stdin"), `got ${JSON.stringify(r2.details)}`);
		assert.ok(typeof r2.details.session_id === "number");

		// Send EOF so cat exits.
		const r3 = await h.call("write_stdin", {
			session_id: sid,
			chars: "\x04",
			yield_time_ms: 1000,
		});
		// Some environments need stdin.end() instead of \x04; in pipe mode \x04 won't EOF.
		// If r3 is still running, force kill to clean up.
		if (r3.details.session_id !== undefined) {
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});

	it("kill_session terminates a stuck process", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "sleep 60",
			yield_time_ms: 300,
		});
		assert.ok(typeof r1.details.session_id === "number");
		const sid = r1.details.session_id;

		const t0 = Date.now();
		const r2 = await h.call("kill_session", { session_id: sid });
		const dt = Date.now() - t0;
		assert.ok(dt < 2500, `kill_session took too long: ${dt}ms`);
		assert.equal(r2.details.session_id, sid);
		// Either signal=SIGTERM, or exit_code set (sleep can be killed with no code).
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("kill_session escalates to SIGKILL when SIGTERM is trapped", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Trap SIGTERM so bash ignores it; SIGKILL should still work.
		const r1 = await h.call("exec_command", {
			cmd: "trap '' TERM; sleep 60",
			yield_time_ms: 300,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid });
		assert.equal(r2.details.escalated, true, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("list_sessions enumerates live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 300 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 2, `details=${JSON.stringify(l.details)}`);
		const ids = l.details.sessions.map((s: any) => s.session_id);
		assert.ok(ids.includes(r1.details.session_id));
		assert.ok(ids.includes(r2.details.session_id));
		// Cleanup.
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.call("kill_session", { session_id: r2.details.session_id });
		await h.emit("session_shutdown");
	});

	it("session_shutdown terminates all live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const r2 = await h.call("exec_command", { cmd: "sleep 11", yield_time_ms: 200 });
		assert.ok(r1.details.session_id);
		assert.ok(r2.details.session_id);
		await h.emit("session_shutdown");
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0);
	});

	it("external abort breaks the yield but leaves session alive", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const ac = new AbortController();
		const promise = h.call(
			"exec_command",
			{ cmd: "sleep 10", yield_time_ms: 30_000 },
			ac.signal,
		);
		setTimeout(() => ac.abort(), 100);
		const t0 = Date.now();
		const r = await promise;
		const dt = Date.now() - t0;
		assert.ok(dt < 2000, `should have returned near abort time; dt=${dt}`);
		// Session should still be alive.
		assert.ok(typeof r.details.session_id === "number", `${JSON.stringify(r.details)}`);
		const sid = r.details.session_id;
		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.session_id === sid));
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("unknown session_id throws", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(
			() => h.call("write_stdin", { session_id: 9999, chars: "hi\n" }),
			/unknown session_id/,
		);
		await h.emit("session_shutdown");
	});

	it("kill_session on unknown id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("kill_session", { session_id: 9999 });
		assert.equal(r.details.found, false);
		await h.emit("session_shutdown");
	});

	it("response includes cwd, command, yield_time_ms in details and header", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo ok", yield_time_ms: 2000 });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.cwd, process.cwd());
		assert.equal(r.details.command, "echo ok");
		assert.equal(r.details.yield_time_ms, 2000);
		// cwd line appears in the LLM-visible header text
		assert.ok(r.content[0].text.includes(`cwd: ${process.cwd()}`), `cwd header missing: ${r.content[0].text}`);
		await h.emit("session_shutdown");
	});

	it("short command includes log_path and tty fields in details", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hello" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.tty, false);
		assert.ok(typeof r.details.log_path === "string" && r.details.log_path.length > 0, `log_path missing: ${JSON.stringify(r.details)}`);
		assert.ok(existsSync(r.details.log_path), `log file should exist: ${r.details.log_path}`);
		// log file should contain the full output verbatim.
		const logContent = readFileSync(r.details.log_path, "utf-8");
		assert.ok(logContent.includes("hello"), `log content: ${logContent}`);
		await h.emit("session_shutdown");
	});

	it("output over 50 KiB is tail-truncated with marker; log file has full bytes", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 4000 lines x ~55 bytes = ~210 KiB of output. Well over the 50 KiB cap.
		const r = await h.call("exec_command", {
			cmd: "for i in $(seq 1 4000); do echo \"line-number-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; done",
			yield_time_ms: 10000,
		});
		assert.equal(r.details.exit_code, 0);

		// details.output is the truncated body only (no header/footer).
		const bytes = Buffer.byteLength(r.details.output, "utf8");
		assert.ok(bytes <= 60 * 1024, `LLM-visible output should be <=60KB; got ${bytes}`);
		assert.ok(bytes > 40 * 1024, `LLM-visible output should be close to 50KiB; got ${bytes}`);
		assert.equal(r.details.truncation.truncatedBy, "bytes");
		assert.equal(r.details.truncation.totalLines, 4001); // 4000 lines + trailing empty

		// The rendered text (what actually goes to the LLM) includes the marker.
		const rendered = r.content[0].text;
		assert.ok(rendered.includes("Showing lines"), `missing truncation marker in rendered text`);
		assert.ok(rendered.includes(r.details.log_path), `marker should reference log_path`);

		// original_token_count should reflect the full ~210KB (not the truncated view).
		assert.ok(r.details.original_token_count > 30_000, `original_token_count=${r.details.original_token_count}`);

		// Log file should contain ALL 4000 lines — full retention on disk.
		const logContent = readFileSync(r.details.log_path, "utf-8");
		const logLines = logContent.split("\n").filter((l) => l.length);
		assert.equal(logLines.length, 4000, `log should have 4000 lines; got ${logLines.length}`);
		await h.emit("session_shutdown");
	});

	it("output over 2000 lines is line-truncated with marker", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// 2500 short lines, well under 50 KiB total → line-cap wins.
		const r = await h.call("exec_command", {
			cmd: "for i in $(seq 1 2500); do echo $i; done",
			yield_time_ms: 10000,
		});
		assert.equal(r.details.exit_code, 0);
		assert.ok(r.details.truncation, `expected truncation metadata`);
		assert.equal(r.details.truncation.truncatedBy, "lines");
		assert.equal(r.details.truncation.outputLines, 2000);
		assert.equal(r.details.truncation.totalLines, 2501); // trailing newline adds empty
		// Marker lives in the rendered content text, not in details.output.
		assert.ok(r.content[0].text.includes("Showing lines"));
		await h.emit("session_shutdown");
	});

	it("list_sessions entries include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 1);
		const entry = l.details.sessions[0];
		assert.equal(entry.session_id, r1.details.session_id);
		assert.equal(entry.log_path, r1.details.log_path);
		assert.ok(existsSync(entry.log_path));
		await h.call("kill_session", { session_id: r1.details.session_id });
		await h.emit("session_shutdown");
	});

	it("kill_session details include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
		const sid = r1.details.session_id;
		const r2 = await h.call("kill_session", { session_id: sid });
		assert.equal(r2.details.log_path, r1.details.log_path);
		await h.emit("session_shutdown");
	});
});
