/**
 * collectOutputUntilDeadline — port of codex's `collect_output_until_deadline`.
 *
 * Drains an output buffer, waking on new-data notifications, until either:
 *   - the deadline passes, or
 *   - the process signals exit AND the output channel is closed, or
 *   - the abort signal fires.
 *
 * When the exit cancellation token fires before the deadline, we give a short
 * `postExitCloseWaitMs` grace (default 50ms) to pick up trailing output before
 * breaking.
 *
 * Design differences vs codex:
 *   - No `pause_state`: pi does not have codex's "out of band elicitation
 *     pause" concept, so the deadline is not extended across pauses.
 *   - Uses `AbortSignal` instead of tokio `CancellationToken`.
 */

import type { HeadTailBuffer } from "./head-tail-buffer.ts";
import { type Gate, type Notify, sleep } from "./notify.ts";

const POST_EXIT_CLOSE_WAIT_MS = 50;

export interface CollectInputs {
	/** Buffer to drain. Chunks removed from it are returned to the caller. */
	buffer: HeadTailBuffer;
	/** Fired when new data arrives in `buffer`. */
	outputNotify: Notify;
	/** Closed when the underlying stream ends (process exit + streams drained). */
	outputClosed: Gate;
	/** Fired as soon as the process has exited (may or may not have trailing output). */
	exited: AbortSignal;
	/** Absolute monotonic deadline (Date.now() ms) to stop waiting. */
	deadlineMs: number;
	/** External abort (e.g. user pressed Esc). Breaks out immediately. */
	externalAbort?: AbortSignal;
	/** Override the trailing-output grace after exit (ms). */
	postExitCloseWaitMs?: number;
}

/**
 * Collect all currently-buffered bytes, then keep waiting for more until the
 * deadline or a break condition. Returns the concatenated byte payload.
 *
 * The buffer is drained non-destructively to the process output pipe — new
 * output arriving after we return stays in the buffer for the next collect().
 */
export async function collectOutputUntilDeadline(inputs: CollectInputs): Promise<Uint8Array> {
	const { buffer, outputNotify, outputClosed, exited, deadlineMs, externalAbort } = inputs;
	const postExitCloseWaitCap = inputs.postExitCloseWaitMs ?? POST_EXIT_CLOSE_WAIT_MS;

	const collected: Uint8Array[] = [];
	let exitSignalReceived = exited.aborted;
	let postExitDeadline: number | undefined;

	for (;;) {
		if (externalAbort?.aborted) break;

		// 1) Drain whatever is currently buffered.
		const drained = buffer.drainChunks();

		if (drained.length === 0) {
			if (exited.aborted) exitSignalReceived = true;
			if (exitSignalReceived && outputClosed.isClosed) break;

			const now = Date.now();
			const remaining = Math.max(0, deadlineMs - now);
			if (remaining === 0) break;

			if (exitSignalReceived) {
				// Process exited but stream not closed yet — give it a short grace.
				if (postExitDeadline === undefined) {
					postExitDeadline = now + Math.min(remaining, postExitCloseWaitCap);
				}
				const graceRemaining = Math.max(0, postExitDeadline - Date.now());
				if (graceRemaining === 0) break;
				const which = await waitAny([
					outputNotify.notified().then(() => "output" as const),
					outputClosed.closed().then(() => "closed" as const),
					sleep(graceRemaining).then(() => "timeout" as const),
					abortPromise(externalAbort).then(() => "external" as const),
				]);
				if (which === "timeout" || which === "external") break;
				continue;
			}

			// Still running — wait for next event.
			const which = await waitAny([
				outputNotify.notified().then(() => "output" as const),
				abortPromise(exited).then(() => "exit" as const),
				sleep(remaining).then(() => "timeout" as const),
				abortPromise(externalAbort).then(() => "external" as const),
			]);
			if (which === "timeout" || which === "external") break;
			if (which === "exit") exitSignalReceived = true;
			continue;
		}

		// 2) Collected some bytes — keep them and loop.
		for (const chunk of drained) collected.push(chunk);

		if (exited.aborted) exitSignalReceived = true;
		if (Date.now() >= deadlineMs) break;
	}

	return concat(collected);
}

/** Return the value of whichever promise resolves first. Tagged with index. */
function waitAny<T>(ps: Array<Promise<T>>): Promise<T> {
	return Promise.race(ps);
}

/** A promise that resolves when the given signal aborts. Never rejects. */
function abortPromise(signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise<void>(() => {}); // pending forever
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}
