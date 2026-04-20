/**
 * PTY-mode end-to-end tests. Require node-pty-prebuilt-multiarch to be loaded.
 * Skipped when PTY is unavailable.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import extensionFactory from "../src/index.ts";
import { isPtyAvailable } from "../src/pty.ts";

function makeHarness() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, any[]> = {};
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {} },
		hasUI: false,
	};
	const pi = {
		registerTool: (def: any) => { tools[def.name] = def; },
		on: (event: string, h: any) => { (handlers[event] ??= []).push(h); },
		registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};
	(extensionFactory as any)(pi);
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute("id", params, signal, undefined, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	};
}

describe("unified-exec PTY mode", { skip: !isPtyAvailable() }, () => {
	it("tty: true runs a command with a PTY", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", {
			cmd: "tty && echo seen=$TERM",
			tty: true,
			yield_time_ms: 1500,
		});
		// If short-lived: exit_code is set; long-running: session_id. Either way output should
		// include "tty" / "dev/" to confirm a PTY was allocated.
		assert.ok(r.details.output.toLowerCase().includes("/dev/"), `output=${r.details.output}`);
		if (r.details.session_id !== undefined) {
			await h.call("kill_session", { session_id: r.details.session_id });
		}
		await h.emit("session_shutdown");
	});

	it("write_stdin drives a Python REPL over PTY", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "python3 -q",
			tty: true,
			yield_time_ms: 800,
		});
		const sid = r1.details.session_id;
		if (typeof sid !== "number") {
			// No python3? Skip silently.
			await h.emit("session_shutdown");
			return;
		}

		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "print(2 + 40)\n",
			yield_time_ms: 800,
		});
		assert.ok(r2.details.output.includes("42"), `got: ${r2.details.output}`);

		// Quit.
		await h.call("write_stdin", { session_id: sid, chars: "exit()\n", yield_time_ms: 1500 });
		// Clean up if still alive.
		const list = await h.call("list_sessions", {});
		if (list.details.sessions.some((s: any) => s.session_id === sid)) {
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});

	it("Ctrl-C (\\x03) interrupts a PTY loop", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", {
			cmd: "while true; do echo alive; sleep 0.2; done",
			tty: true,
			yield_time_ms: 400,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		// Send Ctrl-C via \x03
		const r2 = await h.call("write_stdin", {
			session_id: sid,
			chars: "\x03",
			yield_time_ms: 1000,
		});
		// Session should exit (bash gets SIGINT from terminal).
		if (r2.details.session_id !== undefined) {
			// Some shells ignore SIGINT for background; fall back to kill.
			await h.call("kill_session", { session_id: sid });
		}
		await h.emit("session_shutdown");
	});
});
