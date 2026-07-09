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
import extensionFactory, { MAX_EMPTY_POLL_ENV_VAR, resolveMaxEmptyPollMs } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";

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
	const commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		statuses: new Map<string, string | undefined>(),
		widgets: new Map<string, { content: string[] | undefined; options?: unknown }>(),
		// Queue of responders for ui.select(); each gets the options array.
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => uiEvents.statuses.set(key, value),
			setWidget: (key: string, content: string[] | undefined, options?: unknown) =>
				uiEvents.widgets.set(key, { content, options }),
			select: (_title: string, options: string[]) => {
				const responder = uiEvents.selectResponses.shift();
				return Promise.resolve(responder ? responder(options) : undefined);
			},
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
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
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
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, onUpdate, stubCtx);
		},
		async invokeCommand(name: string, args = "") {
			const cmd = commands[name];
			if (!cmd) throw new Error(`no such command: ${name}`);
			return cmd.handler(args, stubCtx);
		},
		stubCtx,
		uiEvents,
		async emit(event: string, evt: any = {}) {
			const results = [];
			for (const h of handlers[event] ?? []) results.push(await h(evt, stubCtx));
			return results;
		},
	};
}

describe("unified-exec e2e", () => {
	it("resolveMaxEmptyPollMs reads the empty-poll cap env var", () => {
		assert.equal(resolveMaxEmptyPollMs({}), 1_800_000);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "300000" }), 300_000);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "1000" }), 5_000);
		assert.equal(resolveMaxEmptyPollMs({ [MAX_EMPTY_POLL_ENV_VAR]: "not-a-number" }), 1_800_000);
	});

	it("Windows: shell=powershell and shell=cmd get shell-appropriate flags", { skip: !IS_WINDOWS }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "Write-Output ps-ok", shell: "powershell", yield_time_ms: 20000 });
		assert.ok(r1.details.output.includes("ps-ok"), `output=${r1.details.output}`);
		assert.equal(r1.details.exit_code, 0);
		const r2 = await h.call("exec_command", { cmd: "echo cmd-ok", shell: "cmd", yield_time_ms: 20000 });
		assert.ok(r2.details.output.includes("cmd-ok"), `output=${r2.details.output}`);
		assert.equal(r2.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("Windows: cmd.exe quoting survives operators, quotes, %VAR%, parens", { skip: !IS_WINDOWS }, async () => {
		// These are exactly the inputs the /d /s /c "<cmd>" + verbatim-args
		// mechanism exists for; `echo simple` would pass even if it broke.
		const h = makeHarness();
		await h.emit("session_start");
		const cases: Array<{ cmd: string; expect: string[] }> = [
			{ cmd: "echo one& echo two", expect: ["one", "two"] }, // & separator
			{ cmd: 'echo "a & b"', expect: ['"a & b"'] }, // quoted & is literal
			{ cmd: "echo %OS%", expect: ["Windows_NT"] }, // env expansion
			{ cmd: "(echo grouped)", expect: ["grouped"] }, // parentheses
			// findstr, not find: Git Bash environments often shadow Windows'
			// find.exe with GNU find earlier on PATH.
			{ cmd: "echo piped-x | findstr piped", expect: ["piped-x"] }, // pipe
		];
		for (const { cmd, expect } of cases) {
			const r = await h.call("exec_command", { cmd, shell: "cmd", yield_time_ms: 20000 });
			assert.equal(r.details.exit_code, 0, `cmd=${cmd} details=${JSON.stringify(r.details)}`);
			for (const e of expect) {
				assert.ok(r.details.output.includes(e), `cmd=${cmd} expected "${e}" in output=${r.details.output}`);
			}
		}
		await h.emit("session_shutdown");
	});

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

	it("empty write_stdin poll clamps yield_time_ms to 30 minutes by default", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		delete process.env[MAX_EMPTY_POLL_ENV_VAR];
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.4",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;

			await new Promise((r) => setTimeout(r, 700));

			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "",
				yield_time_ms: 2_000_000,
			});
			assert.equal(r2.details.yield_time_ms, 1_800_000);
			assert.equal(r2.details.session_id, undefined);
			assert.equal(r2.details.exit_code, 0);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
	});

	it("empty write_stdin poll cap can be lowered with env var", async () => {
		const previous = process.env[MAX_EMPTY_POLL_ENV_VAR];
		process.env[MAX_EMPTY_POLL_ENV_VAR] = "300000";
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const r1 = await h.call("exec_command", {
				cmd: "sleep 0.4",
				yield_time_ms: 250,
			});
			assert.ok(typeof r1.details.session_id === "number", `got ${JSON.stringify(r1.details)}`);
			const sid = r1.details.session_id;

			await new Promise((r) => setTimeout(r, 700));

			const r2 = await h.call("write_stdin", {
				session_id: sid,
				chars: "",
				yield_time_ms: 2_000_000,
			});
			assert.equal(r2.details.yield_time_ms, 300_000);
			assert.equal(r2.details.session_id, undefined);
			assert.equal(r2.details.exit_code, 0);
		} finally {
			if (previous === undefined) delete process.env[MAX_EMPTY_POLL_ENV_VAR];
			else process.env[MAX_EMPTY_POLL_ENV_VAR] = previous;
			await h.emit("session_shutdown");
		}
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
		if (IS_WINDOWS) {
			// No POSIX signals on Windows: the initial "SIGTERM" is already a
			// force tree-kill (taskkill /T /F) and escalation is skipped (a
			// second identical taskkill can't behave differently). Don't assert
			// on exit timing (taskkill on a loaded runner can exceed the 2s
			// window) — assert the session is gone from the store instead.
			assert.equal(r2.details.escalated, false, `details=${JSON.stringify(r2.details)}`);
			const l = await h.call("list_sessions", {});
			assert.ok(
				!l.details.sessions.some((s: any) => s.session_id === sid && s.running),
				`session ${sid} still listed as running: ${JSON.stringify(l.details)}`,
			);
		} else {
			assert.equal(r2.details.escalated, true, `details=${JSON.stringify(r2.details)}`);
		}
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

	it("session_tree surfaces running sessions in the TUI", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");
		const widget = h.uiEvents.widgets.get("unified-exec.sessions");
		const widgetContent = widget?.content;
		if (!widgetContent) assert.fail(`widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent[0].includes("1 session still running"), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes(`#${sid}`)), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes("write_stdin to poll/drive")));
		assert.ok(
			h.uiEvents.notifications.some((n) => n.type === "warning" && n.message.includes("still running after /tree")),
			`notifications=${JSON.stringify(h.uiEvents.notifications)}`,
		);

		await h.call("kill_session", { session_id: sid });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), undefined);
		assert.equal(h.uiEvents.widgets.get("unified-exec.sessions")?.content, undefined);
		await h.emit("session_shutdown");
	});

	it("running-session footer clears automatically when a background process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");

		await new Promise((r) => setTimeout(r, 700));
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), undefined);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		assert.equal(r2.details.session_id, undefined);
		await h.emit("session_shutdown");
	});

	it("post-tree running-session widget clears automatically when the process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", `details=${JSON.stringify(r1.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.ok(h.uiEvents.widgets.get("unified-exec.sessions")?.content?.[0].includes("1 session still running"));

		await new Promise((r) => setTimeout(r, 700));
		assert.equal(h.uiEvents.widgets.get("unified-exec.sessions")?.content, undefined);

		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("running-session UI decrements when one of multiple sessions exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const short = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250 });
		const long = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 250 });
		const shortSid = short.details.session_id;
		const longSid = long.details.session_id;
		assert.ok(typeof shortSid === "number", `short=${JSON.stringify(short.details)}`);
		assert.ok(typeof longSid === "number", `long=${JSON.stringify(long.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 2 sessions running");

		await new Promise((r) => setTimeout(r, 1100));
		assert.equal(h.uiEvents.statuses.get("unified-exec.sessions"), "unified-exec: 1 session running");
		const widget = h.uiEvents.widgets.get("unified-exec.sessions")?.content?.join("\n") ?? "";
		assert.ok(widget.includes(`#${longSid}`), `widget=${widget}`);
		assert.ok(!widget.includes(`#${shortSid}`), `widget=${widget}`);

		const drained = await h.call("write_stdin", { session_id: shortSid, chars: "", yield_time_ms: 5000 });
		assert.equal(drained.details.exit_code, 0, `details=${JSON.stringify(drained.details)}`);
		await h.call("kill_session", { session_id: longSid });
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

	for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
		it(`session_shutdown reason=${reason} terminates live sessions`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			const r = await h.call("exec_command", { cmd: "sleep 10", yield_time_ms: 200 });
			assert.ok(r.details.session_id);
			await h.emit("session_shutdown", {
				type: "session_shutdown",
				reason,
				targetSessionFile: reason === "new" || reason === "resume" || reason === "fork" ? "/tmp/next.jsonl" : undefined,
			});
			const l = await h.call("list_sessions", {});
			assert.equal(l.details.active_count, 0);
		});
	}

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
		assert.equal(r.details.truncation.totalLines, 4000); // trailing \n does not count an empty line (pi >= 0.80)

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
		assert.equal(r.details.truncation.totalLines, 2500); // trailing \n does not count an empty line (pi >= 0.80)
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

	it("nonexistent shell binary surfaces a failure_message", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hi", shell: "definitely-not-a-real-shell-xyz" });
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		assert.ok(
			typeof r.details.failure_message === "string" && /ENOENT/.test(r.details.failure_message),
			`expected ENOENT failure_message; got ${JSON.stringify(r.details)}`,
		);
		assert.ok(r.content[0].text.includes("failure:"), r.content[0].text);
		await h.emit("session_shutdown");
	});

	it("nonexistent workdir surfaces a failure_message", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo hi", workdir: "/definitely/not/a/real/dir" });
		assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
		assert.ok(
			typeof r.details.failure_message === "string" && /ENOENT/.test(r.details.failure_message),
			`expected ENOENT failure_message; got ${JSON.stringify(r.details)}`,
		);
		await h.emit("session_shutdown");
	});

	it("write_stdin to a child that closed stdin does not crash the host (EPIPE)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "exec 0<&-; sleep 3", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		// First write hits EPIPE asynchronously; must be swallowed, not crash.
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "hello\n", yield_time_ms: 300 });
		assert.ok(r2.details.session_id === sid || r2.details.exit_code !== undefined, JSON.stringify(r2.details));
		// By now the stdin stream is destroyed; a follow-up write should report
		// the failure instead of silently dropping the bytes.
		const r3 = await h.call("write_stdin", { session_id: sid, chars: "again\n", yield_time_ms: 300 });
		if (r3.details.session_id !== undefined) {
			// On Windows, writes to a pipe whose reader closed don't fail
			// deterministically (bytes can sit in the pipe buffer without an
			// error), so the failure note may legitimately never appear. The
			// core guarantee — the host doesn't crash — holds either way.
			if (!IS_WINDOWS) {
				assert.ok(
					typeof r3.details.failure_message === "string" && r3.details.failure_message.includes("stdin"),
					`expected stdin failure note; got ${JSON.stringify(r3.details)}`,
				);
			}
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});

	it("kill_session normalizes signal names (lowercase, no SIG prefix)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 60", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("kill_session", { session_id: sid, signal: "term" });
		assert.equal(r2.details.session_id, sid);
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, JSON.stringify(r2.details));
		await h.emit("session_shutdown");
	});

	it("kill_session rejects unknown signal names instead of silently no-opping", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(() => h.call("kill_session", { session_id: 1, signal: "BOGUS" }), /unknown signal/);
		await h.emit("session_shutdown");
	});

	it("list_sessions reports just-exited sessions once with exit info, then removes them", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		await new Promise((r) => setTimeout(r, 600));

		const l1 = await h.call("list_sessions", {});
		assert.equal(l1.details.active_count, 0, JSON.stringify(l1.details));
		const entry = l1.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry, `exited session should be reported once: ${JSON.stringify(l1.details)}`);
		assert.equal(entry.running, false);
		assert.equal(entry.exit_code, 0);
		assert.ok(l1.content[0].text.includes("exited"), l1.content[0].text);

		const l2 = await h.call("list_sessions", {});
		assert.equal(l2.details.sessions.length, 0, JSON.stringify(l2.details));
		await h.emit("session_shutdown");
	});

	it("session_shutdown SIGKILLs children that trap SIGTERM", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "trap '' TERM; sleep 30", yield_time_ms: 300 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const l = await h.call("list_sessions", {});
		const pid = l.details.sessions.find((s: any) => s.session_id === sid)?.pid;
		assert.ok(typeof pid === "number");

		await h.emit("session_shutdown");
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
	});

	it("onUpdate streams growing partial output while running", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const updates: any[] = [];
		const r = await h.call(
			"exec_command",
			{ cmd: "for i in 1 2 3 4; do echo beat-$i; sleep 0.25; done", yield_time_ms: 1500 },
			undefined,
			(partial: any) => updates.push(partial),
		);
		assert.ok(updates.length >= 2, `expected >=2 partial updates; got ${updates.length}`);
		const first = updates[0];
		const last = updates[updates.length - 1];
		assert.ok(typeof first.details.output === "string");
		assert.ok(last.details.output.length >= first.details.output.length, "output should grow");
		assert.ok(last.details.output.includes("beat-1"), last.details.output);
		assert.ok(
			updates.every((u) => typeof u.details.session_id === "number"),
			"partial updates should carry session_id",
		);
		if (r.details.session_id !== undefined) {
			await h.call("kill_session", { session_id: r.details.session_id });
		}
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command kills a selected session", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("killed 1")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions command can kill all sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		await h.call("exec_command", { cmd: "sleep 31", yield_time_ms: 250 });

		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith("Kill all")));
		await h.invokeCommand("unified-exec-sessions");

		const l = await h.call("list_sessions", {});
		assert.equal(l.details.active_count, 0, JSON.stringify(l.details));
		await h.emit("session_shutdown");
	});

	it("/unified-exec-sessions notifies when there is nothing to kill", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(
			h.uiEvents.notifications.some((n) => n.message.includes("no live sessions")),
			JSON.stringify(h.uiEvents.notifications),
		);
		await h.emit("session_shutdown");
	});
});
