/**
 * Unit tests for yield_until timestamp parsing/validation (src/time.ts).
 * Fully deterministic: `nowMs` is injected, no real clocks or waits.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_ABSOLUTE_WAIT_MS,
	MAX_ABSOLUTE_WAIT_ENV_VAR,
	nowUtcIso,
	parseYieldUntil,
	resolveMaxAbsoluteWaitMs,
} from "../src/time.ts";

const NOW = Date.UTC(2026, 6, 21, 8, 30, 0, 0); // 2026-07-21T08:30:00.000Z
const MAX = DEFAULT_MAX_ABSOLUTE_WAIT_MS;

describe("parseYieldUntil", () => {
	it("accepts a valid Z timestamp without fractional seconds", () => {
		const p = parseYieldUntil("2026-07-21T18:30:00Z", NOW, MAX);
		assert.equal(p.normalized, "2026-07-21T18:30:00.000Z");
		assert.equal(p.remainingMs, 10 * 60 * 60 * 1000);
	});

	it("accepts a valid timestamp with milliseconds", () => {
		const p = parseYieldUntil("2026-07-21T09:30:00.123Z", NOW, MAX);
		assert.equal(p.normalized, "2026-07-21T09:30:00.123Z");
		assert.equal(p.remainingMs, 60 * 60 * 1000 + 123);
	});

	it("pads short fractional seconds (.5 = 500ms)", () => {
		const p = parseYieldUntil("2026-07-21T09:30:00.5Z", NOW, MAX);
		assert.equal(p.normalized, "2026-07-21T09:30:00.500Z");
	});

	it("normalizes accepted values with Date.toISOString()", () => {
		const p = parseYieldUntil("2026-12-31T23:59:59Z", Date.UTC(2026, 11, 31, 23, 0, 0), MAX);
		assert.equal(p.normalized, new Date(p.targetMs).toISOString());
	});

	it("rejects a timestamp without a timezone", () => {
		assert.throws(() => parseYieldUntil("2026-07-21T18:30:00", NOW, MAX), /RFC 3339 UTC/);
	});

	it("rejects +00:00 offsets", () => {
		assert.throws(() => parseYieldUntil("2026-07-21T18:30:00+00:00", NOW, MAX), /RFC 3339 UTC/);
	});

	it("rejects lowercase z", () => {
		assert.throws(() => parseYieldUntil("2026-07-21T18:30:00z", NOW, MAX), /RFC 3339 UTC/);
	});

	it("rejects timestamps missing seconds", () => {
		assert.throws(() => parseYieldUntil("2026-07-21T18:30Z", NOW, MAX), /RFC 3339 UTC/);
	});

	it("rejects more than three fractional digits", () => {
		assert.throws(() => parseYieldUntil("2026-07-21T18:30:00.1234Z", NOW, MAX), /RFC 3339 UTC/);
	});

	it("rejects impossible calendar dates that JS would normalize", () => {
		assert.throws(() => parseYieldUntil("2026-02-30T00:00:00Z", NOW, MAX), /not a valid calendar date/);
		assert.throws(() => parseYieldUntil("2026-13-01T00:00:00Z", NOW, MAX), /not a valid calendar date/);
		assert.throws(() => parseYieldUntil("2026-07-21T25:00:00Z", NOW, MAX), /not a valid calendar date/);
		assert.throws(() => parseYieldUntil("2026-07-21T18:61:00Z", NOW, MAX), /not a valid calendar date/);
	});

	it("accepts Feb 29 in leap years, rejects it otherwise", () => {
		const nowMs = Date.UTC(2028, 1, 28, 20, 0, 0);
		assert.equal(parseYieldUntil("2028-02-29T00:00:00Z", nowMs, MAX).normalized, "2028-02-29T00:00:00.000Z");
		assert.throws(() => parseYieldUntil("2027-02-29T00:00:00Z", Date.UTC(2027, 1, 28), MAX), /not a valid calendar date/);
	});

	it("rejects malformed values", () => {
		for (const bad of ["", "garbage", "2026-07-21", "18:30:00Z", "2026/07/21T18:30:00Z", "2026-07-21 18:30:00Z"]) {
			assert.throws(() => parseYieldUntil(bad, NOW, MAX), /RFC 3339 UTC/, `should reject: ${JSON.stringify(bad)}`);
		}
	});

	it("treats a past deadline as an immediate poll, not an error", () => {
		const p = parseYieldUntil("2026-07-21T08:00:00Z", NOW, MAX);
		assert.equal(p.remainingMs, 0);
		assert.equal(p.normalized, "2026-07-21T08:00:00.000Z");
	});

	it("rejects deadlines beyond the configured horizon (never clamps)", () => {
		assert.throws(
			() => parseYieldUntil("2026-07-21T18:30:00.001Z", NOW, MAX),
			/beyond the maximum absolute wait horizon/,
		);
		// Exactly at the horizon is accepted.
		assert.equal(parseYieldUntil("2026-07-21T18:30:00Z", NOW, MAX).remainingMs, MAX);
	});

	it("validation errors include the current host UTC time (tool_time_utc)", () => {
		for (const bad of ["not-a-time", "2026-02-30T00:00:00Z", "2036-07-21T18:30:00Z"]) {
			try {
				parseYieldUntil(bad, NOW, MAX);
				assert.fail(`should have thrown for ${bad}`);
			} catch (err) {
				assert.match((err as Error).message, /tool_time_utc: 2026-07-21T08:30:00\.000Z/);
			}
		}
	});
});

describe("resolveMaxAbsoluteWaitMs", () => {
	it("defaults to 10 hours", () => {
		assert.equal(resolveMaxAbsoluteWaitMs({}), 36_000_000);
	});
	it("honors the env override", () => {
		assert.equal(resolveMaxAbsoluteWaitMs({ [MAX_ABSOLUTE_WAIT_ENV_VAR]: "7200000" }), 7_200_000);
	});
	it("ignores invalid values", () => {
		assert.equal(resolveMaxAbsoluteWaitMs({ [MAX_ABSOLUTE_WAIT_ENV_VAR]: "bogus" }), 36_000_000);
		assert.equal(resolveMaxAbsoluteWaitMs({ [MAX_ABSOLUTE_WAIT_ENV_VAR]: "-1" }), 36_000_000);
	});
});

describe("nowUtcIso", () => {
	it("formats the injected instant as ISO UTC", () => {
		assert.equal(nowUtcIso(NOW), "2026-07-21T08:30:00.000Z");
	});
});
