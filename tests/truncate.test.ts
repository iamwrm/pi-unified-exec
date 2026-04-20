/**
 * Unit tests for truncateTail — the port of pi's built-in tail-truncation.
 *
 * Cases mirror pi's own behavior as closely as possible.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "../src/truncate.ts";

describe("truncateTail", () => {
	it("passes short content through untouched", () => {
		const r = truncateTail("hello\nworld\n");
		assert.equal(r.truncated, false);
		assert.equal(r.truncatedBy, null);
		assert.equal(r.content, "hello\nworld\n");
		assert.equal(r.totalLines, 3); // "hello", "world", ""
		assert.equal(r.outputLines, 3);
		assert.equal(r.lastLinePartial, false);
	});

	it("truncates by line cap", () => {
		// 3000 lines, each ~10 chars → ~30 KB total (under byte cap),
		// but lines > 2000 → line-cap truncation.
		const lines: string[] = [];
		for (let i = 1; i <= 3000; i++) lines.push(`line ${i}`);
		const text = lines.join("\n");
		const r = truncateTail(text);
		assert.equal(r.truncated, true);
		assert.equal(r.truncatedBy, "lines");
		assert.equal(r.outputLines, DEFAULT_MAX_LINES);
		assert.equal(r.totalLines, 3000);
		// The last line should be "line 3000"
		const resultLines = r.content.split("\n");
		assert.equal(resultLines[resultLines.length - 1], "line 3000");
		// And the first kept line should be "line 1001" (since we keep last 2000)
		assert.equal(resultLines[0], "line 1001");
		assert.equal(r.lastLinePartial, false);
	});

	it("truncates by byte cap", () => {
		// 5 lines, each 20 KB → 100 KB total, 5 lines (under line cap).
		const chunk = "x".repeat(20 * 1024);
		const text = `${chunk}\n${chunk}\n${chunk}\n${chunk}\n${chunk}`;
		const r = truncateTail(text);
		assert.equal(r.truncated, true);
		assert.equal(r.truncatedBy, "bytes");
		assert.equal(r.totalLines, 5);
		assert.ok(r.outputBytes <= DEFAULT_MAX_BYTES, `outputBytes=${r.outputBytes}`);
		assert.equal(r.lastLinePartial, false); // complete lines kept
	});

	it("edge case: last line alone exceeds byte cap → keeps tail of that line as partial", () => {
		const line = "a".repeat(DEFAULT_MAX_BYTES + 1024); // one line, slightly over cap
		const r = truncateTail(line);
		assert.equal(r.truncated, true);
		assert.equal(r.truncatedBy, "bytes");
		assert.equal(r.lastLinePartial, true);
		assert.equal(r.outputLines, 1);
		assert.ok(r.outputBytes <= DEFAULT_MAX_BYTES);
	});

	it("respects custom maxLines", () => {
		const text = "a\nb\nc\nd\ne\n";
		// split → ["a","b","c","d","e",""] (6 entries). Keep last 2 → ["e", ""] → "e\n".
		const r = truncateTail(text, { maxLines: 2 });
		assert.equal(r.truncated, true);
		assert.equal(r.truncatedBy, "lines");
		assert.equal(r.content, "e\n");
		assert.equal(r.outputLines, 2);
	});

	it("respects custom maxLines without trailing newline", () => {
		const text = "a\nb\nc\nd\ne"; // 5 lines, no trailing \n
		const r = truncateTail(text, { maxLines: 3 });
		assert.equal(r.truncated, true);
		assert.equal(r.content, "c\nd\ne");
		assert.equal(r.outputLines, 3);
	});

	it("respects custom maxBytes", () => {
		const text = "abcdefghij";
		const r = truncateTail(text, { maxBytes: 5 });
		assert.equal(r.truncated, true);
		assert.equal(r.truncatedBy, "bytes");
		assert.equal(r.outputBytes, 5);
		assert.equal(r.content, "fghij");
		assert.equal(r.lastLinePartial, true);
	});

	it("handles empty input", () => {
		const r = truncateTail("");
		assert.equal(r.truncated, false);
		assert.equal(r.content, "");
		assert.equal(r.totalBytes, 0);
		assert.equal(r.totalLines, 1); // "".split("\n") === [""]
	});

	it("handles UTF-8 multibyte chars cleanly", () => {
		// 3 KB of emoji, well under 50 KiB cap — no truncation.
		const line = "🎉".repeat(1024);
		const r = truncateTail(line);
		assert.equal(r.truncated, false);
		assert.equal(r.content, line);
	});

	it("partial-last-line truncation respects UTF-8 boundaries", () => {
		const emoji = "🎉"; // 4 bytes
		// ~60 KiB of emoji in one line → forced to tail-truncate inside a line
		const line = emoji.repeat(16 * 1024); // 64 KiB
		const r = truncateTail(line, { maxBytes: 50 * 1024 });
		assert.equal(r.truncated, true);
		assert.equal(r.lastLinePartial, true);
		// Content should decode cleanly: every char is an emoji.
		const expectedChar = emoji;
		// All chars in the result must be the full emoji (no broken surrogates).
		for (const ch of [...r.content]) {
			assert.equal(ch, expectedChar, `expected all emoji, got: ${ch.codePointAt(0)?.toString(16)}`);
		}
	});
});

describe("formatSize", () => {
	it("formats bytes", () => {
		assert.equal(formatSize(0), "0B");
		assert.equal(formatSize(1023), "1023B");
	});
	it("formats KB", () => {
		assert.equal(formatSize(1024), "1.0KB");
		assert.equal(formatSize(50 * 1024), "50.0KB");
	});
	it("formats MB", () => {
		assert.equal(formatSize(1024 * 1024), "1.0MB");
		assert.equal(formatSize((1024 * 1024 * 3) / 2), "1.5MB");
	});
});
