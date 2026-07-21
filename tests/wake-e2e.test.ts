/**
 * Integration tests for write_stdin's `yield_until` (absolute deadline) and
 * exec_command's `on_exit: "wake"` through the real tool pipeline.
 *
 * Uses a stub ExtensionAPI that captures pi.sendMessage calls and can emit
 * tool_execution_end / agent_settled lifecycle events. Subprocess-based tests
 * are kept small and cross-platform (sleep/echo through the default shell).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
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
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
	};

	(extensionFactory as any)(pi);

	let nextCallId = 1;
	return {
		/** Call a tool with a fresh toolCallId; returns { result, toolCallId }. */
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `call-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, signal, onUpdate, stubCtx);
			return { ...result, toolCallId };
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		/** Simulate pi finalizing a tool result. */
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "", result: {}, isError });
		},
		sentMessages,
		uiEvents,
	};
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A strict-format future UTC deadline (toISOString matches the accepted grammar). */
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("write_stdin yield_until", () => {
	it("rejects yield_time_ms and yield_until together", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		await assert.rejects(
			() => h.call("write_stdin", { session_id: sid, yield_time_ms: 5000, yield_until: inFuture(5000) }),
			/not both.*tool_time_utc/s,
		);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("rejects non-empty chars or decoded chars_b64 with yield_until; accepts explicit empty input", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		await assert.rejects(
			() => h.call("write_stdin", { session_id: sid, chars: "hello\n", yield_until: inFuture(5000) }),
			/only valid for an empty poll/,
		);
		await assert.rejects(
			// "aGk=" decodes to non-empty "hi"
			() => h.call("write_stdin", { session_id: sid, chars_b64: "aGk=", yield_until: inFuture(5000) }),
			/only valid for an empty poll/,
		);
		// Explicit empty chars + yield_until is a valid empty poll.
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_until: inFuture(300) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_mode, "absolute");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("rejects malformed timestamps at the tool boundary with tool_time_utc", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		for (const bad of ["2026-07-21 18:30:00", "2026-07-21T18:30:00+00:00", "2026-02-30T00:00:00Z"]) {
			await assert.rejects(
				() => h.call("write_stdin", { session_id: sid, yield_until: bad }),
				/tool_time_utc/,
				`should reject ${bad}`,
			);
		}
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("returns the terminal result immediately when the process exits before the deadline", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4 && echo done-marker", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		const t0 = Date.now();
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) });
		assert.ok(Date.now() - t0 < 10_000, "must return on exit, not at the deadline");
		assert.equal(r2.details.exit_code, 0, JSON.stringify(r2.details));
		assert.equal(r2.details.session_id, undefined);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.wait_status, "completed");
		assert.equal(r2.details.completion_delivery, "direct");
		assert.match(r2.details.yield_until, /Z$/);
		assert.match(r2.details.tool_time_utc, /Z$/);
		assert.ok(r2.details.output.includes("done-marker"), r2.details.output);
		// Full output landed in the log too.
		assert.ok(readFileSync(r2.details.log_path, "utf-8").includes("done-marker"));
		await h.emit("session_shutdown");
	});

	it("returns the still-running session when the absolute deadline arrives first", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo early-output && sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(700) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		assert.ok(typeof r2.details.effective_wait_ms === "number" && r2.details.effective_wait_ms >= 500);
		assert.match(r2.details.tool_time_utc, /Z$/);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("treats a past deadline as an immediate poll", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo hi && sleep 30", yield_time_ms: 400 });
		const sid = r1.details.session_id;
		const t0 = Date.now();
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: "2020-01-01T00:00:00Z" });
		assert.ok(Date.now() - t0 < 3000, "past deadline = immediate poll");
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("cancellation leaves the process alive with output retrievable later", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "echo pre-cancel-output && sleep 30", yield_time_ms: 600 });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");

		// Poll once to leave fresh un-drained output before the cancelled wait.
		const ac = new AbortController();
		const inflight = h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) }, ac.signal);
		setTimeout(() => ac.abort(), 150);
		const r2 = await inflight;
		assert.equal(r2.details.session_id, sid, JSON.stringify(r2.details));
		assert.equal(r2.details.wait_status, "cancelled");
		assert.equal(r2.details.output, "", "cancelled waits must not drain output");

		// The process survived; buffered output is still retrievable.
		const r3 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r3.details.session_id, sid);
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});

	it("absolute waits do not run a 250ms heartbeat (rate-limited updates only)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Chatty process: prints every 100ms.
		const r1 = await h.call("exec_command", {
			cmd: "for i in $(seq 1 40); do echo chatty-$i; sleep 0.1; done",
			yield_time_ms: 250,
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const updates: any[] = [];
		const r2 = await h.call(
			"write_stdin",
			{ session_id: sid, yield_until: inFuture(1500) },
			undefined,
			(p: any) => updates.push(p),
		);
		// A 250ms heartbeat would produce ~6 updates in 1.5s of chatty output.
		// The rate-limited streamer (30s interval) emits initial + final only.
		assert.ok(updates.length <= 3, `expected <=3 rate-limited updates; got ${updates.length}`);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		await h.call("kill_session", { session_id: sid });
		await h.emit("session_shutdown");
	});
});

describe("exec_command on_exit", () => {
	it("omitted or explicit 'none' preserves current behavior (no wake)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250 });
		const r2 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "none" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(typeof r2.details.session_id === "number");
		assert.equal(r2.details.completion_notification, undefined);
		await new Promise((r) => setTimeout(r, 1200)); // both exit + debounce window
		assert.equal(h.sentMessages.length, 0);
		// Drain them.
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
		await h.call("write_stdin", { session_id: r2.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});

	it("wake process exiting inside the initial exec_command yield gives a direct result, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { cmd: "echo quick", yield_time_ms: 5000, on_exit: "wake" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("backgrounded wake session exiting while idle sends exactly one follow-up prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Output ("BYE") deliberately differs from the command text ("bye") so we
		// can assert the wake carries command metadata but never raw stdout.
		const r1 = await h.call("exec_command", {
			cmd: "sleep 0.4 && echo bye | tr a-z A-Z",
			yield_time_ms: 250,
			on_exit: "wake",
		});
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		assert.equal(r1.details.completion_notification, "armed");
		assert.equal(r1.details.on_exit, "wake");
		assert.ok(r1.content[0].text.includes("completion_notification: armed"), r1.content[0].text);

		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "unified-exec-completed");
		assert.equal(message.display, true);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /exit_code=0/);
		assert.ok(!message.content.includes("BYE"), "wake must not contain raw stdout");

		// After the wake, the exited session's output is still retrievable…
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0);
		assert.ok(r2.details.output.includes("BYE"));
		await h.finalizeTool(r2.toolCallId, false);
		// …and consuming it does not send another wake.
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.emit("session_shutdown");
	});

	it("exit during a relative write_stdin observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.completion_delivery, "direct");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("exit during an absolute yield_until observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.wait_mode, "absolute");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("absolute deadline first, then exit: still-running result keeps wake armed; exactly one wake follows", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_until: inFuture(400) });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.wait_status, "absolute_deadline_reached");
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1, "exactly one");
		// Lazy drain still works after the wake.
		const r3 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
		assert.equal(r3.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("cancelled absolute wait keeps the wake armed; later exit sends exactly one wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const ac = new AbortController();
		const inflight = h.call("write_stdin", { session_id: sid, yield_until: inFuture(60_000) }, ac.signal);
		setTimeout(() => ac.abort(), 150);
		const r2 = await inflight;
		assert.equal(r2.details.wait_status, "cancelled");
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, true); // pi records the cancelled call as error
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 }).catch(() => {});
		await h.emit("session_shutdown");
	});

	it("a terminal result finalized as error keeps the completion wake-eligible", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		// Pi finalizes the constructed result as an error → wake must fire.
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake despite constructed result");
		await h.emit("session_shutdown");
	});

	it("explicit model kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await h.call("kill_session", { session_id: sid });
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("human slash-command kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("list_sessions observing the exit before notification suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		// Wait for the natural exit, then reap via list_sessions BEFORE the
		// debounced wake can be verified — observeViaListing wins if it runs
		// before the flush; either way at most one notification total.
		await sleep(700);
		const l = await h.call("list_sessions", {});
		const entry = l.details.sessions.find((s: any) => s.session_id === sid);
		assert.ok(entry && entry.running === false);
		await new Promise((res) => setTimeout(res, 600));
		assert.ok(h.sentMessages.length <= 1, `never more than one notification; got ${h.sentMessages.length}`);
		await h.emit("session_shutdown");
	});

	it("session_shutdown cancels pending wakes (no stale prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		// Shut down before the process exits / the debounce fires.
		await h.emit("session_shutdown");
		await new Promise((res) => setTimeout(res, 800));
		assert.equal(h.sentMessages.length, 0);
	});

	it("several wake sessions finishing together produce one bounded batch", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Both processes block on the same marker file so their exits land within
		// a few tens of ms of each other — inside the wake debounce window.
		const marker = `${process.env.TMPDIR || "/tmp"}/unified-exec-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const waitCmd = `while [ ! -f "${marker}" ]; do sleep 0.05; done`;
		const a = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const b = await h.call("exec_command", { cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const release = await h.call("exec_command", { cmd: `touch "${marker}"`, yield_time_ms: 5000 });
		assert.equal(release.details.exit_code, 0);
		assert.ok(typeof a.details.session_id === "number");
		assert.ok(typeof b.details.session_id === "number");
		assert.ok(await waitFor(() => h.sentMessages.length >= 1), "batch wake expected");
		await new Promise((res) => setTimeout(res, 800));
		assert.equal(h.sentMessages.length, 1, "one prompt for both completions");
		const content = h.sentMessages[0].message.content;
		assert.match(content, new RegExp(`session_id=${a.details.session_id}`));
		assert.match(content, new RegExp(`session_id=${b.details.session_id}`));
		await h.call("write_stdin", { session_id: a.details.session_id, yield_time_ms: 5000 });
		await h.call("write_stdin", { session_id: b.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});

	it("agent_settled flushes a wake whose send previously failed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		// Make the first send throw.
		const originalPush = h.sentMessages.push.bind(h.sentMessages);
		let failures = 1;
		(h.sentMessages as any).push = (...args: any[]) => {
			if (failures > 0) {
				failures--;
				throw new Error("synthetic send failure");
			}
			return originalPush(...args);
		};
		const r1 = await h.call("exec_command", { cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		await sleep(900); // exit + failed debounce flush
		assert.equal(h.sentMessages.length, 0);
		await h.emit("agent_settled", { type: "agent_settled" });
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "retry at agent_settled");
		await h.call("write_stdin", { session_id: r1.details.session_id, yield_time_ms: 5000 });
		await h.emit("session_shutdown");
	});
});
