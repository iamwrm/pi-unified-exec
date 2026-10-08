/**
 * Steer gate — lets a human steering message end an attached wait early.
 *
 * Pi delivers queued steering only after the whole tool batch finishes, so a
 * long `write_stdin` poll would otherwise hold a steer for the full wait.
 * The gate turns "a human steer is queued" into one shared AbortSignal that
 * every live wait listens to:
 *
 *   input(streamingBehavior: "steer")  → confirm via ctx.hasPendingMessages()
 *                                        (a later input handler may have
 *                                        "handled" and dropped the text)
 *   confirmed                          → pending++, abort the shared signal
 *   message_start(role: "user")        → Pi delivered one queued message:
 *                                        pending-- (floored at 0)
 *   agent_settled / session change     → reset
 *
 * When nothing is pending the signal is fresh (unaborted). Waits never kill
 * the child; they only return early with the output gathered so far.
 * Steers queued by other extensions via sendMessage fire no `input` event
 * and are intentionally not interrupts.
 */

export const STEER_INTERRUPT_ENV = "PI_UNIFIED_EXEC_STEER_INTERRUPT";

/** Shown to the model when a wait returns because the human steered. */
export const STEER_NOTE =
	"returned early: the user sent a steering message, which Pi delivers next. " +
	"The process is still running; read the steer first, then re-poll this session_id only if it is still relevant.";

/** Thrown for nested (codemode) calls while a steer is pending, so a polling script ends. */
export const STEER_NESTED_ERROR =
	"unified-exec: the user sent a steering message; this script call was stopped so Pi can deliver it. " +
	"Running sessions were not killed — re-poll them after reading the steer if still relevant.";

/** The subset of Pi's ExtensionContext the gate consults. */
export interface PendingProbe {
	hasPendingMessages?: () => boolean;
}

export interface SteerGateOptions {
	enabled?: boolean;
	/** Interval between confirmation probes after a steer input (ms). */
	confirmIntervalMs?: number;
	/** Give up confirming after this long (the input was handled/dropped). */
	confirmWindowMs?: number;
}

/** Whether steer interrupts are enabled (default on; `0` opts out). */
export function steerInterruptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[STEER_INTERRUPT_ENV] !== "0";
}

/** Nested calls made through ctx.executeTool() carry `<parent>/<n>` ids. */
export function isNestedToolCall(toolCallId: string): boolean {
	return toolCallId.includes("/");
}

export class SteerGate {
	readonly enabled: boolean;
	private readonly confirmIntervalMs: number;
	private readonly confirmWindowMs: number;
	private pending = 0;
	private controller = new AbortController();
	private readonly confirmTimers = new Set<NodeJS.Timeout>();

	constructor(opts: SteerGateOptions = {}) {
		this.enabled = opts.enabled ?? true;
		this.confirmIntervalMs = opts.confirmIntervalMs ?? 10;
		this.confirmWindowMs = opts.confirmWindowMs ?? 1000;
	}

	/** Aborted while a human steer is queued; replaced once it is delivered. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get pendingCount(): number {
		return this.pending;
	}

	/**
	 * Whether a steer is queued. With a probe, a stale count (Pi's queue is
	 * already empty, e.g. cleared by the user) is dropped first.
	 */
	isPending(probe?: PendingProbe): boolean {
		if (this.pending > 0 && typeof probe?.hasPendingMessages === "function" && !probe.hasPendingMessages()) {
			// Keep in-flight confirmations: a newer steer may still be arriving.
			this.pending = 0;
			this.freshSignal();
		}
		return this.pending > 0;
	}

	/**
	 * Called from Pi's `input` event for a steer. The event fires before the
	 * text is queued, so confirm asynchronously against Pi's queue.
	 */
	onSteerInput(probe: PendingProbe): void {
		if (!this.enabled) return;
		if (typeof probe.hasPendingMessages !== "function") {
			this.markPending();
			return;
		}
		const startedAt = Date.now();
		const check = () => {
			this.confirmTimers.delete(timer);
			let queued = false;
			try {
				queued = probe.hasPendingMessages!();
			} catch {
				return; // stale context (session replaced): drop
			}
			if (queued) {
				this.markPending();
			} else if (Date.now() - startedAt < this.confirmWindowMs) {
				timer = setTimeout(check, this.confirmIntervalMs);
				timer.unref?.();
				this.confirmTimers.add(timer);
			}
		};
		let timer = setTimeout(check, 0);
		timer.unref?.();
		this.confirmTimers.add(timer);
	}

	/** Mark one human steer as queued and release every live wait. */
	markPending(): void {
		if (!this.enabled) return;
		this.pending++;
		if (!this.controller.signal.aborted) this.controller.abort();
	}

	/** Pi delivered a queued user message (steer or follow-up). */
	onUserMessageDelivered(): void {
		if (this.pending === 0) return;
		this.pending--;
		if (this.pending === 0) this.freshSignal();
	}

	/** Forget everything (run settled, session change, shutdown). */
	reset(): void {
		for (const t of this.confirmTimers) clearTimeout(t);
		this.confirmTimers.clear();
		this.pending = 0;
		this.freshSignal();
	}

	private freshSignal(): void {
		if (this.controller.signal.aborted) this.controller = new AbortController();
	}
}
