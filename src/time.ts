/**
 * Wall-clock deadline parsing for `write_stdin`'s `yield_until` parameter.
 *
 * `yield_until` is a strict RFC 3339 UTC subset of ISO 8601:
 *   - complete date and time, including seconds
 *   - zero to three fractional-second digits
 *   - uppercase trailing `Z` (no offsets, no local time)
 *   - a real calendar date (JavaScript's silent Date normalization of
 *     impossible dates like 2026-02-30 is rejected, not accepted)
 *
 * The parsed wall-clock instant is converted ONCE into a relative duration
 * (`remainingMs`) against the caller-supplied `nowMs`. The wait itself must
 * then run on a monotonic clock (see long-wait.ts) so later NTP adjustments
 * or manual system-clock changes cannot lengthen or shorten an in-progress
 * wait.
 */

/** Env override for the maximum absolute wait horizon. */
export const MAX_ABSOLUTE_WAIT_ENV_VAR = "PI_UNIFIED_EXEC_MAX_ABSOLUTE_WAIT_MS";

/** Default maximum absolute wait horizon: 10 hours. */
export const DEFAULT_MAX_ABSOLUTE_WAIT_MS = 10 * 60 * 60 * 1000;

/** Current host UTC time in ISO form — the trustworthy clock surfaced to the model. */
export function nowUtcIso(nowMs: number = Date.now()): string {
	return new Date(nowMs).toISOString();
}

export function resolveMaxAbsoluteWaitMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_ABSOLUTE_WAIT_ENV_VAR]?.trim();
	if (!raw) return DEFAULT_MAX_ABSOLUTE_WAIT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ABSOLUTE_WAIT_MS;
	return Math.floor(parsed);
}

// Strict shape: YYYY-MM-DDTHH:MM:SS[.mmm]Z — uppercase Z only, 0–3 fraction digits.
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export interface ParsedYieldUntil {
	/** Epoch milliseconds of the target instant. */
	targetMs: number;
	/** Canonical `Date.toISOString()` form for result metadata. */
	normalized: string;
	/** Remaining duration relative to `nowMs`, floored at 0 (past deadlines poll immediately). */
	remainingMs: number;
}

/**
 * Parse and validate a `yield_until` timestamp. Throws an actionable Error
 * (always including the current host UTC time as `tool_time_utc`) on:
 *   - malformed / non-UTC / offset timestamps
 *   - impossible calendar dates
 *   - deadlines further out than `maxAbsoluteWaitMs` (never silently clamped)
 *
 * A deadline in the past is NOT an error: it yields `remainingMs: 0`
 * (an immediate poll).
 */
export function parseYieldUntil(raw: string, nowMs: number, maxAbsoluteWaitMs: number): ParsedYieldUntil {
	const toolTime = nowUtcIso(nowMs);
	const m = RFC3339_UTC_RE.exec(raw);
	if (!m) {
		throw new Error(
			`yield_until must be an RFC 3339 UTC timestamp like "2026-07-21T18:30:00Z" or ` +
				`"2026-07-21T18:30:00.123Z" (complete date and time with seconds, 0-3 fractional digits, ` +
				`uppercase trailing "Z"; offsets such as "+00:00" and local timestamps are rejected). ` +
				`Got: "${raw}". tool_time_utc: ${toolTime}`,
		);
	}
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	const fracMs = m[7] ? Number(m[7].padEnd(3, "0")) : 0;

	const targetMs = Date.UTC(year, month - 1, day, hour, minute, second, fracMs);
	const roundTrip = new Date(targetMs);
	// Reject impossible dates/times that Date.UTC silently normalizes
	// (2026-02-30 → March 2, 25:00 → next day 01:00, second 61, …).
	if (
		roundTrip.getUTCFullYear() !== year ||
		roundTrip.getUTCMonth() !== month - 1 ||
		roundTrip.getUTCDate() !== day ||
		roundTrip.getUTCHours() !== hour ||
		roundTrip.getUTCMinutes() !== minute ||
		roundTrip.getUTCSeconds() !== second
	) {
		throw new Error(
			`yield_until "${raw}" is not a valid calendar date/time (it would be silently normalized ` +
				`to ${roundTrip.toISOString()}). tool_time_utc: ${toolTime}`,
		);
	}

	const remaining = targetMs - nowMs;
	if (remaining > maxAbsoluteWaitMs) {
		throw new Error(
			`yield_until "${raw}" is ${Math.round(remaining / 1000)}s in the future, beyond the maximum ` +
				`absolute wait horizon of ${maxAbsoluteWaitMs} ms (${Math.round(maxAbsoluteWaitMs / 3_600_000 * 10) / 10} h; ` +
				`configurable via ${MAX_ABSOLUTE_WAIT_ENV_VAR}). Excessive deadlines are rejected, not clamped — ` +
				`pass a nearer deadline and call again if the process is still running. tool_time_utc: ${toolTime}`,
		);
	}

	return {
		targetMs,
		normalized: roundTrip.toISOString(),
		remainingMs: Math.max(0, remaining),
	};
}
