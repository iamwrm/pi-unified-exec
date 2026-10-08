/**
 * Steer interrupt: a queued human steering message ends attached waits early
 * (src/steer-gate.ts, runAttachedWait, short-yield collect).
 *
 * Unit tests cover the gate and the wait primitive; the e2e tests drive the
 * real tools against short-lived child processes through a stub ExtensionAPI.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { waitForExitOrDeadline } from "../src/long-wait.ts";
import extensionFactory from "../src/index.ts";
import { isNestedToolCall, STEER_INTERRUPT_ENV, SteerGate, steerInterruptEnabled } from "../src/steer-gate.ts";

process.env.PI_UNIFIED_EXEC_COMPACT_CODEMODE = "0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await sleep(10);
	}
	return cond();
}

describe("SteerGate", () => {
	it("confirms a steer against Pi's queue and aborts the shared signal", async () => {
		const gate = new SteerGate();
		const signal = gate.signal;
		gate.onSteerInput({ hasPendingMessages: () => true });
		assert.ok(await waitFor(() => signal.aborted));
		assert.equal(gate.pendingCount, 1);
	});

	it("ignores a steer that an input handler dropped (queue stays empty)", async () => {
		const gate = new SteerGate({ confirmWindowMs: 60 });
		gate.onSteerInput({ hasPendingMessages: () => false });
		await sleep(120);
		assert.equal(gate.signal.aborted, false);
		assert.equal(gate.pendingCount, 0);
	});

	it("waits for Pi to queue the steer after the input event", async () => {
		const gate = new SteerGate();
		let queued = false;
		setTimeout(() => (queued = true), 40);
		gate.onSteerInput({ hasPendingMessages: () => queued });
		assert.equal(gate.signal.aborted, false);
		assert.ok(await waitFor(() => gate.signal.aborted));
	});

	it("re-arms with a fresh signal once every queued steer is delivered", () => {
		const gate = new SteerGate();
		gate.markPending();
		gate.markPending();
		const first = gate.signal;
		gate.onUserMessageDelivered();
		assert.equal(gate.signal, first, "one steer still queued");
		assert.ok(gate.signal.aborted);
		gate.onUserMessageDelivered();
		assert.notEqual(gate.signal, first);
		assert.equal(gate.signal.aborted, false);
		gate.onUserMessageDelivered(); // an ordinary prompt: floored at zero
		assert.equal(gate.pendingCount, 0);
	});

	it("drops a stale count when Pi's queue is already empty", () => {
		const gate = new SteerGate();
		gate.markPending();
		assert.equal(gate.isPending({ hasPendingMessages: () => true }), true);
		assert.equal(gate.isPending({ hasPendingMessages: () => false }), false);
		assert.equal(gate.signal.aborted, false);
	});

	it("never fires when disabled", async () => {
		const gate = new SteerGate({ enabled: false });
		gate.onSteerInput({ hasPendingMessages: () => true });
		gate.markPending();
		await sleep(30);
		assert.equal(gate.signal.aborted, false);
		assert.equal(steerInterruptEnabled({ [STEER_INTERRUPT_ENV]: "0" }), false);
		assert.equal(steerInterruptEnabled({}), true);
	});

	it("recognizes nested ctx.executeTool() call ids", () => {
		assert.equal(isNestedToolCall("toolu_01/3"), true);
		assert.equal(isNestedToolCall("toolu_01"), false);
	});
});

describe("waitForExitOrDeadline steerAbort", () => {
	it("returns 'steered' when a steer is already queued", async () => {
		const steer = new AbortController();
		steer.abort();
		const outcome = await waitForExitOrDeadline({
			exited: new AbortController().signal,
			steerAbort: steer.signal,
			durationMs: 60_000,
		});
		assert.equal(outcome, "steered");
	});

	it("returns 'steered' promptly mid-wait", async () => {
		const steer = new AbortController();
		const t0 = Date.now();
		setTimeout(() => steer.abort(), 50);
		const outcome = await waitForExitOrDeadline({
			exited: new AbortController().signal,
			steerAbort: steer.signal,
			durationMs: 60_000,
		});
		assert.equal(outcome, "steered");
		assert.ok(Date.now() - t0 < 2000);
	});

	it("exit wins over a simultaneous steer", async () => {
		const exited = new AbortController();
		const steer = new AbortController();
		exited.abort();
		steer.abort();
		assert.equal(
			await waitForExitOrDeadline({ exited: exited.signal, steerAbort: steer.signal, durationMs: 60_000 }),
			"exit",
		);
	});
});

// ---------------- e2e through the real tools ----------------

interface ToolDef {
	name: string;
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	let queued = 0;
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
		hasUI: false,
		hasPendingMessages: () => queued > 0,
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
		getActiveTools: () => [],
		setActiveTools: () => {},
		sendMessage: () => {},
	};
	(extensionFactory as any)(pi);
	let nextId = 1;
	const emit = async (event: string, evt: any = {}) => {
		for (const h of handlers[event] ?? []) await h(evt, stubCtx);
	};
	const harness = {
		emit,
		async call(name: string, params: any, opts: { id?: string; signal?: AbortSignal } = {}) {
			return tools[name].execute(opts.id ?? `call-${nextId++}`, params, opts.signal, undefined, stubCtx);
		},
		/** A human steer: Pi's input event, then the message lands in its queue. */
		async steer() {
			const p = emit("input", { type: "input", text: "stop", source: "interactive", streamingBehavior: "steer" });
			queued++;
			await p;
		},
		/** Pi delivers one queued message at the next turn. */
		async deliver() {
			queued = Math.max(0, queued - 1);
			await emit("message_start", { type: "message_start", message: { role: "user", content: [] } });
		},
		async shutdown() {
			await emit("session_shutdown");
		},
	};
	live.add(harness);
	return harness;
}

const live = new Set<{ shutdown: () => Promise<void> }>();
afterEach(async () => {
	for (const h of live) await h.shutdown();
	live.clear();
});

async function startLongJob(h: ReturnType<typeof makeHarness>, extra: Record<string, unknown> = {}) {
	const r = await h.call("exec_command", { cmd: "echo job-started; sleep 30", yield_time_ms: 300, ...extra });
	assert.equal(typeof r.details.session_id, "number", JSON.stringify(r.details));
	return r.details.session_id as number;
}

describe("steer interrupt e2e", () => {
	it("ends a long relative empty poll early and keeps the process alive", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h);
		const t0 = Date.now();
		setTimeout(() => void h.steer(), 200);
		const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 });
		assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
		assert.equal(r.details.wait_status, "interrupted_by_steer");
		assert.equal(r.details.session_id, sid);
		assert.equal(r.details.running, true);
		assert.match(r.details.note, /steering message/);
		assert.match(r.content[0].text, /wait_status: interrupted_by_steer/);
	});

	it("drains output buffered before the steer", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { cmd: "sleep 0.4; echo late-line; sleep 30", yield_time_ms: 250 });
		const sid = r1.details.session_id;
		await sleep(700);
		await h.steer();
		const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 });
		assert.equal(r.details.wait_status, "interrupted_by_steer");
		assert.match(r.details.output, /late-line/);
	});

	it("returns immediately when the steer was queued before the poll, then waits normally after delivery", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h);
		await h.steer();
		await sleep(30); // let the gate confirm
		const t0 = Date.now();
		const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 });
		assert.ok(Date.now() - t0 < 1000);
		assert.equal(r.details.wait_status, "interrupted_by_steer");

		await h.deliver();
		const r2 = await h.call("write_stdin", { session_id: sid, chars: "", yield_time_ms: 5000 });
		assert.equal(r2.details.wait_status, "relative_deadline_reached");
	});

	it("releases every parallel wait in the batch", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const a = await startLongJob(h);
		const b = await startLongJob(h);
		setTimeout(() => void h.steer(), 150);
		const t0 = Date.now();
		const [ra, rb] = await Promise.all([
			h.call("write_stdin", { session_id: a, yield_time_ms: 600_000 }),
			h.call("write_stdin", { session_id: b, yield_time_ms: 600_000 }),
		]);
		assert.ok(Date.now() - t0 < 5000);
		assert.equal(ra.details.wait_status, "interrupted_by_steer");
		assert.equal(rb.details.wait_status, "interrupted_by_steer");
	});

	it("interrupts an absolute yield_until wait", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h);
		setTimeout(() => void h.steer(), 150);
		const r = await h.call("write_stdin", {
			session_id: sid,
			yield_until: new Date(Date.now() + 3_600_000).toISOString(),
		});
		assert.equal(r.details.wait_status, "interrupted_by_steer");
		assert.equal(r.details.wait_mode, "absolute");
	});

	it("keeps an armed wake armed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h, { on_exit: "wake" });
		setTimeout(() => void h.steer(), 150);
		const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 });
		assert.equal(r.details.wait_status, "interrupted_by_steer");
		assert.equal(r.details.completion_notification, "armed");
	});

	it("ends exec_command's yield early but still returns a live session", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		setTimeout(() => void h.steer(), 400);
		const t0 = Date.now();
		const r = await h.call("exec_command", { cmd: "echo begun; sleep 30", yield_time_ms: 20_000 });
		assert.ok(Date.now() - t0 < 5000);
		assert.equal(typeof r.details.session_id, "number");
		assert.equal(r.details.wait_status, "interrupted_by_steer");
		assert.match(r.details.output, /begun/);
	});

	it("stops a nested codemode call while a steer is queued", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h);
		await h.steer();
		await sleep(30); // let the gate confirm
		await assert.rejects(
			h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 }, { id: "codemode-1/2" }),
			/steering message/,
		);
		await assert.rejects(h.call("exec_command", { cmd: "echo nope" }, { id: "codemode-1/3" }), /steering message/);
	});

	it("Esc still cancels without draining (unchanged)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const sid = await startLongJob(h);
		const esc = new AbortController();
		setTimeout(() => esc.abort(), 150);
		const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 600_000 }, { signal: esc.signal });
		assert.equal(r.details.wait_status, "cancelled");
	});

	it("is a no-op when steer interrupts are disabled", async () => {
		process.env[STEER_INTERRUPT_ENV] = "0";
		try {
			const h = makeHarness();
			await h.emit("session_start");
			const sid = await startLongJob(h);
			await h.steer();
			await sleep(30);
			const r = await h.call("write_stdin", { session_id: sid, yield_time_ms: 5000 });
			assert.equal(r.details.wait_status, "relative_deadline_reached");
		} finally {
			delete process.env[STEER_INTERRUPT_ENV];
		}
	});
});
