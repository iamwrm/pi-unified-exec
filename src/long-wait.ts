/**
 * Event-driven wait for both relative and absolute empty `write_stdin` polls.
 *
 * Unlike collectOutputUntilDeadline, this wait never accumulates drained
 * output in a per-call array. A long noisy process retains bounded output:
 *
 *   - listens ONLY on process exit, external cancellation, and one timer;
 *   - never drains process output (the session's HeadTailBuffer keeps its
 *     bounded head/tail retention, the rolling UI tail keeps rolling, and the
 *     log file keeps receiving every byte);
 *   - runs on a MONOTONIC clock: the wall-clock deadline is converted once
 *     into a duration by the caller, then anchored to `performance.now()`
 *     here, so a later NTP adjustment or manual system-clock change cannot
 *     lengthen or shorten an in-progress wait.
 */

export type LongWaitOutcome = "exit" | "deadline" | "cancelled";

/**
 * Max single setTimeout arm. Values above ~2^31-1 overflow and fire early;
 * multi-day yield_until waits re-arm in chunks of this size instead.
 */
export const MAX_TIMER_ARM_MS = 2_147_483_647; // 2^31 - 1

export interface LongWaitInputs {
	/** Aborts when the process has exited. */
	exited: AbortSignal;
	/** External cancellation (Esc / tool-call abort). Never kills the child. */
	externalAbort?: AbortSignal;
	/** Validated duration in ms; absolute callers compute it once from wall time. */
	durationMs: number;
	/** Injectable monotonic clock (default: performance.now). Test hook. */
	monotonicNow?: () => number;
	/** Injectable timer functions. Test hooks. */
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Wait until the process exits, the tool call is cancelled, or the monotonic
 * deadline arrives — whichever happens first. All timers and listeners are
 * released on every exit path.
 */
export async function waitForExitOrDeadline(inputs: LongWaitInputs): Promise<LongWaitOutcome> {
	const { exited, externalAbort, durationMs } = inputs;
	const monotonicNow = inputs.monotonicNow ?? (() => performance.now());
	const setTimeoutFn = inputs.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
	const clearTimeoutFn = inputs.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

	if (!Number.isFinite(durationMs) || Math.abs(durationMs) > Number.MAX_SAFE_INTEGER) {
		throw new Error("Wait duration must be finite and within the safe millisecond range.");
	}
	if (exited.aborted) return "exit";
	if (externalAbort?.aborted) return "cancelled";
	if (durationMs <= 0) return "deadline";

	// Subtract elapsed time rather than adding a possibly enormous duration
	// to the clock. This accepts the full safe millisecond range without an
	// overflowing or imprecise absolute deadline. Never consult wall time.
	const startedAt = monotonicNow();
	const remainingMs = () => durationMs - (monotonicNow() - startedAt);

	const cleanups: Array<() => void> = [];
	try {
		const exitP = new Promise<LongWaitOutcome>((resolve) => {
			const onAbort = () => resolve("exit");
			exited.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => exited.removeEventListener("abort", onAbort));
		});
		const cancelP: Promise<LongWaitOutcome> = externalAbort
			? new Promise((resolve) => {
					const onAbort = () => resolve("cancelled");
					externalAbort.addEventListener("abort", onAbort, { once: true });
					cleanups.push(() => externalAbort.removeEventListener("abort", onAbort));
				})
			: new Promise<never>(() => {});

		// Single timer, re-armed only if it fires before the monotonic deadline
		// (coarse timer granularity, or multi-day waits chunked below the
		// setTimeout overflow ceiling). No polling loop, no per-chunk wakeups.
		let timerHandle: unknown;
		cleanups.push(() => {
			if (timerHandle !== undefined) clearTimeoutFn(timerHandle);
		});
		const armTimer = (): Promise<void> =>
			new Promise<void>((resolve) => {
				const remaining = Math.max(1, remainingMs());
				const armMs = Math.min(remaining, MAX_TIMER_ARM_MS);
				timerHandle = setTimeoutFn(() => {
					timerHandle = undefined;
					resolve();
				}, armMs);
			});

		for (;;) {
			const which = await Promise.race([exitP, cancelP, armTimer().then(() => "timer" as const)]);
			if (which === "exit" || which === "cancelled") return which;
			// Timer fired: trust only the monotonic clock.
			if (remainingMs() <= 0) return "deadline";
			if (timerHandle !== undefined) {
				clearTimeoutFn(timerHandle);
				timerHandle = undefined;
			}
		}
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

// ---------------- Rate-limited streaming for empty polls ----------------

/** Minimal Notify surface (src/notify.ts) needed by the rate-limited streamer. */
interface NotifyLike {
	notified(): Promise<void>;
}

export interface RateLimitedStreamOptions {
	/** Fired whenever new output arrives (session.outputNotify). */
	outputNotify: NotifyLike;
	/** Emit one non-destructive tail-snapshot update. */
	emit: () => void;
	/** Minimum interval between output-driven updates (ms). */
	minIntervalMs: number;
	/** Injectable monotonic clock. Test hook. */
	monotonicNow?: () => number;
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * TUI updates for an empty poll. An ordinary periodic heartbeat must not
 * run for hours, so this streamer:
 *   - emits one initial waiting update;
 *   - emits output-driven updates rate-limited to `minIntervalMs`
 *     (coalescing bursts into at most one trailing update);
 *   - emits one final update on stop;
 *   - emits NOTHING when no output arrives — no periodic wakeups.
 */
export function startRateLimitedStream(opts: RateLimitedStreamOptions): { stop: () => void } {
	const monotonicNow = opts.monotonicNow ?? (() => performance.now());
	const setTimeoutFn = opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
	const clearTimeoutFn = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

	let stopped = false;
	let lastEmitAt = monotonicNow();
	let trailingTimer: unknown;

	const safeEmit = () => {
		lastEmitAt = monotonicNow();
		try {
			opts.emit();
		} catch {
			// ignore transient render errors
		}
	};

	// Initial waiting update.
	safeEmit();

	// Output-driven loop: parked on outputNotify, not on a timer. A stale
	// parked waiter after stop() is released by the session's next notifyAll
	// (exit always notifies) and then no-ops.
	void (async () => {
		while (!stopped) {
			await opts.outputNotify.notified();
			if (stopped) return;
			const since = monotonicNow() - lastEmitAt;
			if (since >= opts.minIntervalMs) {
				safeEmit();
			} else if (trailingTimer === undefined) {
				// Coalesce the burst into one trailing update.
				trailingTimer = setTimeoutFn(() => {
					trailingTimer = undefined;
					if (!stopped) safeEmit();
				}, opts.minIntervalMs - since);
			}
		}
	})();

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			if (trailingTimer !== undefined) {
				clearTimeoutFn(trailingTimer);
				trailingTimer = undefined;
			}
			// Final update so the TUI shows the last tail state.
			safeEmit();
		},
	};
}
