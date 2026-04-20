/**
 * Tail truncation — direct port of pi's built-in `truncateTail` (see
 * `@mariozechner/pi-coding-agent`'s dist/core/tools/truncate.js).
 *
 * Two independent caps, whichever hits first:
 *   - DEFAULT_MAX_LINES  (2000)
 *   - DEFAULT_MAX_BYTES  (50 KiB)
 *
 * Tail-preserving: keeps the most recent lines/bytes. Never returns a partial
 * line EXCEPT the edge case where the final line alone exceeds the byte cap —
 * in that case we keep its last `maxBytes` (valid-UTF-8) suffix.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50 KiB

export interface TruncateOptions {
	maxLines?: number;
	maxBytes?: number;
}

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	maxLines: number;
	maxBytes: number;
}

/**
 * Truncate a utf-8 string from the tail (keep last N lines/bytes).
 *
 * Matches pi's built-in `bash` tool truncation, line-for-line.
 */
export function truncateTail(content: string, options: TruncateOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i]!;
		// +1 for the newline that rejoins this line to its successor, except
		// for the very first line we keep (which has no predecessor in the
		// output).
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (outputLinesArr.length === 0) {
				// Edge case: the last line alone is larger than the byte cap.
				// Keep its last maxBytes, respecting UTF-8 code point boundaries.
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}
		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		maxLines,
		maxBytes,
	};
}

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Take the last `maxBytes` of a utf-8 string, aligned to a code-point
 * boundary. (Cuts inside a multi-byte character are bumped forward.)
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;
	let start = buf.length - maxBytes;
	// Advance past any continuation bytes (0b10xxxxxx) to land on a start byte.
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
		start++;
	}
	return buf.subarray(start).toString("utf-8");
}
