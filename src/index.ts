/**
 * unified-exec — pi extension that ports codex's unified_exec session model,
 * with pi's built-in `bash` tool's on-disk retention layered on top.
 *
 * Tools exposed to the LLM:
 *   - exec_command(cmd, workdir?, shell?, tty?, yield_time_ms?)
 *   - write_stdin(session_id, chars?, yield_time_ms?)
 *   - kill_session(session_id, signal?)          [pi-flavor; codex has no equivalent]
 *   - list_sessions()                            [pi-flavor]
 *
 * Semantics:
 *   - Every exec_command starts a long-lived session. If the process is still
 *     alive when the call's yield deadline expires, the tool returns with
 *     `session_id` in its body and the LLM can follow up with write_stdin.
 *   - `write_stdin` with empty `chars` is a pure poll; with non-empty, it also
 *     writes the bytes (including \\x03 for Ctrl-C, \\x04 for EOF).
 *   - Aborting the tool call (Esc) breaks the wait but does not kill the
 *     session; the next turn can still drive it.
 *   - Sessions are terminated on session_shutdown (codex parity).
 *   - Every byte the child writes goes to a per-session log file at
 *     /tmp/pi-unified-exec-<sid>-<random>.log. The LLM sees the last ~50 KiB
 *     / 2000 lines per call and the full file is available via `read`.
 */

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { collectOutputUntilDeadline } from "./collect.ts";
import { sleep } from "./notify.ts";
import { isPtyAvailable, getPtyLoadError } from "./pty.ts";
import { renderExecCommandCall, renderResult, renderWriteStdinCall } from "./render.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type TruncationResult } from "./truncate.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
const MAX_BACKGROUND_POLL_MS = 300_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const HEAD_TAIL_MAX_BYTES = 1_048_576; // 1 MiB
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // onUpdate cadence

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

function clampEmptyPollYield(ms: number | undefined): number {
	const v = typeof ms === "number" && ms > 0 ? ms : DEFAULT_WRITE_STDIN_YIELD_MS;
	return clamp(Math.floor(v), MIN_EMPTY_YIELD_TIME_MS, MAX_BACKGROUND_POLL_MS);
}

function generateChunkId(): string {
	return randomBytes(3).toString("hex");
}

function approxTokenCount(bytes: Uint8Array): number {
	// Mirror codex's rough `approx_token_count` behaviour: 4 bytes ≈ 1 token.
	return Math.ceil(bytes.length / 4);
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

function decode(bytes: Uint8Array): string {
	return textDecoder.decode(bytes);
}

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}

/**
 * Format the pi-bash style "[Showing lines X-Y of Z. Full output: <path>]" footer
 * that appears below truncated output.
 */
function truncationMarker(t: TruncationResult, logPath: string | undefined): string | null {
	if (!t.truncated) return null;
	const full = logPath ? `. Full output: ${logPath}` : "";
	if (t.lastLinePartial) {
		return `[Showing last ${formatSize(t.outputBytes)} of final line (line ${t.totalLines} is larger than the ${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
	}
	const startLine = t.totalLines - t.outputLines + 1;
	const endLine = t.totalLines;
	if (t.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${t.totalLines}${full}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${full}]`;
}

/** Human-friendly rendering of the tool response. */
interface ResponseShape {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	original_token_count?: number;
	session_id?: number;
	exit_code?: number;
	signal?: string;
	failure_message?: string;
	tty?: boolean;
	log_path?: string;
	cwd?: string;
	command?: string;
	yield_time_ms?: number;
	truncation?: TruncationResult;
}

function renderResponseText(shape: ResponseShape): string {
	const lines: string[] = [];
	const prefix = shape.session_id !== undefined ? "still running" : "exited";
	lines.push(`[${prefix}]`);
	if (shape.session_id !== undefined) lines.push(`session_id: ${shape.session_id}`);
	if (shape.exit_code !== undefined) lines.push(`exit_code: ${shape.exit_code}`);
	if (shape.signal) lines.push(`signal: ${shape.signal}`);
	if (shape.failure_message) lines.push(`failure: ${shape.failure_message}`);
	if (shape.log_path) lines.push(`log_path: ${shape.log_path}`);
	if (shape.cwd) lines.push(`cwd: ${shape.cwd}`);
	lines.push(`wall_time_seconds: ${shape.wall_time_seconds.toFixed(3)}`);
	lines.push(`chunk_id: ${shape.chunk_id}`);
	if (shape.original_token_count !== undefined) lines.push(`original_token_count: ${shape.original_token_count}`);
	if (shape.tty !== undefined) lines.push(`tty: ${shape.tty}`);
	const header = lines.join("\n");
	const body = shape.output || "(no output)";
	const marker = shape.truncation ? truncationMarker(shape.truncation, shape.log_path) : null;
	const footer = marker ? `\n\n${marker}` : "";
	return `${header}\n---\n${body}${footer}`;
}

// ---------------- Extension ----------------

interface ExtensionCtx {
	store: SessionStore;
	ui: ExtensionContext["ui"] | undefined;
}

type ExecCommandArgs = {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
};

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_b64?: string;
	yield_time_ms?: number;
};

/**
 * Resolve the two mutually-exclusive input channels (`chars` and
 * `chars_b64`) to a single byte payload. Throws on conflicts or malformed
 * base64.
 */
function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		// Decode C-style escapes so the LLM can send \x03, \x1b, \n, etc.
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	cwd: string,
): Promise<ResponseShape> {
	const tty = args.tty ?? false;
	if (tty && !isPtyAvailable()) {
		throw new Error(
			`tty: true requires node-pty-prebuilt-multiarch but it failed to load: ${getPtyLoadError() ?? "unknown"}.\n` +
				`Run:  cd .pi/extensions/unified-exec && npm install\n` +
				`Or call with tty: false (default).`,
		);
	}

	const shellBin = args.shell ?? "bash";
	const command = [shellBin, "-c", args.cmd];
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? args.workdir : cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command,
		cwd: effectiveCwd,
		env: process.env,
		tty,
		displayCommand: args.cmd,
		shell: shellBin,
	});

	if (session.failureMessage) {
		ctx.store.releaseId(id);
		return finalizeResponse({
			wallTimeSec: 0,
			collected: new Uint8Array(0),
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			tty,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Early-exit grace: if the process dies within 150 ms, treat it as a
	// short-lived command and never register it.
	const start = Date.now();
	const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
	await Promise.race([
		new Promise<void>((resolve) => {
			if (session.hasExited) return resolve();
			session.exited.addEventListener("abort", () => resolve(), { once: true });
		}),
		sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
	]);

	if (session.hasExited && Date.now() <= earlyDeadline + 20) {
		// Fully short-lived: collect everything in the buffer + any trailing bytes.
		// Use a small deadline to pick up anything still pending.
		const collected = await collectOutputUntilDeadline({
			buffer: session.outputBuffer,
			outputNotify: session.outputNotify,
			outputClosed: session.outputClosed,
			exited: session.exited,
			deadlineMs: Date.now() + 50,
			externalAbort: signal,
		});
		ctx.store.releaseId(id);
		const wallSec = (Date.now() - start) / 1000;
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty,
			logPath: session.logPath,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	// Live session: register it BEFORE we keep polling, so an early abort
	// doesn't let the session be GC'd / lose its place.
	const { pruned, count } = ctx.store.insert(session);
	if (pruned) {
		ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
	}
	if (count >= WARNING_SESSIONS) {
		ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
	}
	// Note: sessions stay in the store until the next tool call (write_stdin /
	// list_sessions / kill_session) observes the exit and removes them lazily.
	// Matches codex so the LLM can always call write_stdin on a session_id it
	// was handed and get a proper `exit_code` back, even across turns.

	// Wait until the yield deadline (or abort/exit). Stream updates meanwhile.
	const deadlineMs = start + yieldTimeMs;
	const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
	const collected = await collectOutputUntilDeadline({
		buffer: session.outputBuffer,
		outputNotify: session.outputNotify,
		outputClosed: session.outputClosed,
		exited: session.exited,
		deadlineMs,
		externalAbort: signal,
	});
	pollStream.stop();

	session.touch();
	const stillAlive = !session.hasExited;
	const wallSec = (Date.now() - start) / 1000;

	if (stillAlive) {
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: null,
			tty,
			logPath: session.logPath,
			cwd: effectiveCwd,
			command: args.cmd,
			yieldTimeMs,
		});
	}
	// Process exited during this call → respond with exit info, not a session_id.
	ctx.store.remove(session.id);
	return finalizeResponse({
		wallTimeSec: wallSec,
		collected,
		sessionId: undefined,
		exitCode: session.exitCode,
		signal: session.signal,
		failure: session.failureMessage,
		tty,
		logPath: session.logPath,
		cwd: effectiveCwd,
		command: args.cmd,
		yieldTimeMs,
	});
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
): Promise<ResponseShape> {
	const session = ctx.store.get(args.session_id);
	if (!session) {
		throw new Error(`unknown session_id: ${args.session_id}`);
	}
	const writeBytes = resolveWriteInput(args);
	const isEmptyPoll = writeBytes === undefined || writeBytes.length === 0;
	const yieldTimeMs = isEmptyPoll ? clampEmptyPollYield(args.yield_time_ms) : clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);

	const start = Date.now();
	session.touch();

	if (!isEmptyPoll && writeBytes) {
		const ok = session.write(writeBytes);
		if (!ok && session.hasExited) {
			// Session already exited; return its final state.
			const collected = await collectOutputUntilDeadline({
				buffer: session.outputBuffer,
				outputNotify: session.outputNotify,
				outputClosed: session.outputClosed,
				exited: session.exited,
				deadlineMs: Date.now() + 50,
				externalAbort: signal,
			});
			ctx.store.remove(session.id);
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				tty: session.tty,
				logPath: session.logPath,
				cwd: session.cwd,
				command: session.displayCommand,
				yieldTimeMs,
			});
		}
		// Give the child a small window to react before the poll.
		await sleep(100, signal);
	}

	const deadlineMs = start + yieldTimeMs;
	const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
	const collected = await collectOutputUntilDeadline({
		buffer: session.outputBuffer,
		outputNotify: session.outputNotify,
		outputClosed: session.outputClosed,
		exited: session.exited,
		deadlineMs,
		externalAbort: signal,
	});
	pollStream.stop();
	const wallSec = (Date.now() - start) / 1000;

	if (session.hasExited) {
		ctx.store.remove(session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			tty: session.tty,
			logPath: session.logPath,
			cwd: session.cwd,
			command: session.displayCommand,
			yieldTimeMs,
		});
	}
	return finalizeResponse({
		wallTimeSec: wallSec,
		collected,
		sessionId: session.id,
		exitCode: undefined,
		signal: null,
		failure: null,
		tty: session.tty,
		logPath: session.logPath,
		cwd: session.cwd,
		command: session.displayCommand,
		yieldTimeMs,
	});
}

interface FinalizeInput {
	wallTimeSec: number;
	collected: Uint8Array;
	sessionId: number | undefined;
	exitCode: number | null | undefined;
	signal: NodeJS.Signals | null;
	failure: string | null;
	tty: boolean;
	logPath: string | undefined;
	cwd?: string;
	command?: string;
	yieldTimeMs?: number;
}

function finalizeResponse(input: FinalizeInput): ResponseShape {
	const { wallTimeSec, collected, sessionId, exitCode, signal, failure, tty, logPath, cwd, command, yieldTimeMs } = input;
	const rawText = decode(collected);
	const originalTokens = approxTokenCount(collected);
	const truncation = truncateTail(rawText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const shape: ResponseShape = {
		chunk_id: generateChunkId(),
		wall_time_seconds: wallTimeSec,
		output: truncation.content,
		original_token_count: originalTokens,
		tty,
	};
	if (sessionId !== undefined) shape.session_id = sessionId;
	if (exitCode !== undefined && exitCode !== null) shape.exit_code = exitCode;
	if (signal) shape.signal = signal;
	if (failure) shape.failure_message = failure;
	if (logPath) shape.log_path = logPath;
	if (cwd) shape.cwd = cwd;
	if (command) shape.command = command;
	if (yieldTimeMs) shape.yield_time_ms = yieldTimeMs;
	if (truncation.truncated) shape.truncation = truncation;
	return shape;
}

function startStreaming(
	session: ExecSession,
	onUpdate: ((partial: { content: [{ type: "text"; text: string }]; details: unknown }) => void) | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	const tick = () => {
		if (stopped) return;
		try {
			const tail = session.snapshotStreamTail();
			const tailText = decode(tail);
			onUpdate({
				content: [{ type: "text", text: tailText }],
				details: {
					session_id: session.id,
					pid: session.pid,
					running: !session.hasExited,
					total_bytes: session.totalBytesSeen,
					tty: session.tty,
					command: session.displayCommand,
					cwd: session.cwd,
					log_path: session.logPath,
					// Populate `output` so renderResult has a single source regardless
					// of streaming vs final state.
					output: tailText,
				},
			});
		} catch {
			// ignore transient errors
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		interval = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	let interval: NodeJS.Timeout | undefined = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (interval) clearTimeout(interval);
		},
	};
}

export default function (pi: ExtensionAPI) {
	const ctx: ExtensionCtx = {
		store: new SessionStore({
			maxSessions: MAX_SESSIONS,
			lruProtectedCount: LRU_PROTECTED_COUNT,
			onEvict: (s, reason) => {
				if (reason === "lru") {
					// Status clear + warning handled at insert-site; no-op here.
				}
			},
		}),
		ui: undefined,
	};

	// By default, unified-exec removes pi's built-in `bash` tool so the LLM
	// is steered toward exec_command/write_stdin. Pass --keep-builtin-bash to
	// preserve the built-in alongside the unified-exec tools.
	pi.registerFlag("keep-builtin-bash", {
		description: "Keep pi's built-in `bash` tool alongside exec_command/write_stdin. By default it is removed.",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		// Default behavior is to remove the built-in `bash` tool. Only keep it
		// if --keep-builtin-bash was passed. Flag lookup uses the registered
		// name without leading dashes.
		const keep = pi.getFlag("keep-builtin-bash") ?? pi.getFlag("--keep-builtin-bash");
		if (keep !== true) {
			const active = pi.getActiveTools();
			const filtered = active.filter((name) => name !== "bash");
			if (filtered.length !== active.length) {
				pi.setActiveTools(filtered);
			}
		}
		if (!isPtyAvailable() && eventCtx.hasUI) {
			// Non-fatal: pipes mode still works.
			eventCtx.ui.notify(
				"unified-exec: node-pty not available; tty: true will fail. Pipes (tty: false) still work.",
				"info",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		const drained = ctx.store.terminateAll();
		if (drained.length && ctx.ui) {
			ctx.ui.notify(`unified-exec: terminated ${drained.length} live session(s) on shutdown`, "info");
		}
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: [
			"Runs a command in a persistent session and returns output after yield_time_ms, along with",
			"EITHER `session_id` (session still running — follow up with write_stdin) OR `exit_code`",
			"(session finished). Default yield is 10000ms, clamped to [250, 30000].",
			"Use tty: true for interactive commands that need a terminal (REPLs, ssh, sudo prompts, TUIs).",
		].join(" "),
		promptSnippet: "Run a command in a persistent session (codex-style unified_exec)",
		promptGuidelines: [
			"Every exec_command opens a persistent session. If the response contains `session_id` (not `exit_code`), the process is still running — follow up with write_stdin to poll or send input.",
			"Pick yield_time_ms based on expected duration: ~500ms for quick scripts, 10_000 default, up to 30_000 for commands you expect to finish inline. For dev servers and watchers, rely on the default and use write_stdin to poll later.",
			"Use `tty: true` for interactive programs that need a terminal (REPLs, ssh, sudo, TUIs). Default `tty: false` is pipe-based and suffices for scripts.",
		],
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(Type.String({ description: "Shell binary. Defaults to bash." })),
			tty: Type.Optional(Type.Boolean({ description: "Allocate a PTY. Default false (plain pipes)." })),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) to wait for output before yielding. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params as ExecCommandArgs, signal, onUpdate as any, eventCtx.cwd);
			return {
				content: [{ type: "text", text: renderResponseText(shape) }],
				details: shape,
			};
		},
		renderCall: renderExecCommandCall as any,
		renderResult: renderResult as any,
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description: [
			"Writes characters to an existing unified-exec session and returns recent output.",
			"Empty `chars`/`chars_b64` with yield_time_ms polls without writing.",
			"`chars` is decoded as a C-style escape string: \\n \\r \\t \\xHH \\uHHHH \\u{H\u2026} \\0 \\a \\e \\b \\f \\v \\\\ \\\" are interpreted;",
			"unknown escapes (e.g. \\q) pass through literally. For raw binary use `chars_b64` (base64-encoded bytes).",
			"Default yield 250ms; for empty polls yield is clamped to [5000, 300000].",
		].join(" "),
		promptSnippet: "Drive or poll a running unified-exec session",
		promptGuidelines: [
			"Empty `chars`/`chars_b64` = poll only. Use to wait for more output from a running session.",
			"`chars` supports C-style escapes: send `\\x03` for Ctrl-C, `\\x04` for EOF, `\\x1b` for ESC, `\\n` for newline. Unknown escapes (`\\q`, `\\.`, etc.) pass through literally. Use `\\\\` for a literal backslash.",
			"For arbitrary binary input use `chars_b64` instead (base64-encoded bytes). Mutually exclusive with `chars`.",
			"If the response contains `exit_code`, the session has ended and its session_id is no longer valid.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Identifier of the running session (from exec_command)." }),
			chars: Type.Optional(
				Type.String({
					description:
						"C-style escape string to write to stdin. Supports \\n \\r \\t \\xHH \\uHHHH \\u{H\u2026} \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X pass through literally. Empty = pure poll. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description:
						"Base64-encoded bytes to write to stdin. Use for arbitrary binary or exact byte control. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) to wait for output before yielding. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}; for empty input clamped to [${MIN_EMPTY_YIELD_TIME_MS}, ${MAX_BACKGROUND_POLL_MS}].`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params as WriteStdinArgs, signal, onUpdate as any);
			return {
				content: [{ type: "text", text: renderResponseText(shape) }],
				details: shape,
			};
		},
		renderCall: renderWriteStdinCall as any,
		renderResult: renderResult as any,
	});

	pi.registerTool({
		name: "kill_session",
		label: "kill_session",
		description: "Terminate a live unified-exec session. Sends SIGTERM; escalates to SIGKILL after 2s if still alive.",
		promptSnippet: "Terminate a unified-exec session",
		promptGuidelines: [
			"Use to force-stop a runaway session the process won't exit via Ctrl-C (`write_stdin` with chars='\\x03').",
			"After kill_session, the session_id is invalid. Don't reuse it.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = ((params as any).signal as NodeJS.Signals | undefined) ?? "SIGTERM";
			const session = ctx.store.get(sid);
			if (!session) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
				};
			}
			const start = Date.now();
			session.kill(initial);
			// Wait up to 2s for exit.
			const exitDeadline = start + 2000;
			while (!session.hasExited && Date.now() < exitDeadline) {
				await sleep(50);
			}
			let escalated = false;
			if (!session.hasExited) {
				session.kill("SIGKILL");
				escalated = true;
				const kdeadline = Date.now() + 500;
				while (!session.hasExited && Date.now() < kdeadline) {
					await sleep(25);
				}
			}
			// Final drain.
			const collected = await collectOutputUntilDeadline({
				buffer: session.outputBuffer,
				outputNotify: session.outputNotify,
				outputClosed: session.outputClosed,
				exited: session.exited,
				deadlineMs: Date.now() + 100,
			});
			ctx.store.remove(sid);
			const text = decode(collected);
			const details = {
				session_id: sid,
				final_output: text,
				exit_code: session.exitCode,
				signal: session.signal,
				escalated,
				log_path: session.logPath,
			};
			const summary =
				`Killed session ${sid} (pid ${session.pid ?? "?"}) with ${initial}` +
				(escalated ? " — escalated to SIGKILL" : "") +
				(session.exitCode !== null ? ` — exit_code=${session.exitCode}` : session.signal ? ` — signal=${session.signal}` : "");
			const logLine = session.logPath ? `\nlog_path: ${session.logPath}` : "";
			return {
				content: [{ type: "text", text: `${summary}${logLine}\n---\n${text || "(no output)"}` }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "list_sessions",
		description: "List all live unified-exec sessions in this pi run.",
		promptSnippet: "Enumerate live unified-exec sessions",
		promptGuidelines: [
			"Use if you lost track of a session_id, or to audit what's running before starting new work.",
		],
		parameters: Type.Object({}),
		async execute() {
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them). This mirrors codex's
			// `refresh_process_state` filter when enumerating live processes.
			for (const s of ctx.store.values()) {
				if (s.hasExited) ctx.store.remove(s.id);
			}
			const now = Date.now();
			const sessions = ctx.store.values().map((s) => ({
				session_id: s.id,
				command: s.displayCommand,
				cwd: s.cwd,
				tty: s.tty,
				pid: s.pid,
				started_at_ms: s.startedAt,
				elapsed_ms: now - s.startedAt,
				running: !s.hasExited,
				output_bytes_total: s.totalBytesSeen,
				log_path: s.logPath,
			}));
			const lines = sessions.length
				? sessions.map(
						(s) =>
							`  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${
								s.tty ? "tty" : "pipe"
							}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}  ${s.command.length > 60 ? s.command.slice(0, 60) + "…" : s.command}\n        log: ${s.log_path}`,
					)
				: ["  (no live sessions)"];
			return {
				content: [{ type: "text", text: `unified-exec sessions (${sessions.length}):\n${lines.join("\n")}` }],
				details: { sessions, active_count: sessions.length },
			};
		},
	});
}
