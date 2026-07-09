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
import { constants as osConstants } from "node:os";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	truncateTail,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { collectOutputUntilDeadline } from "./collect.ts";
import { sleep } from "./notify.ts";
import { isPtyAvailable, getPtyLoadError } from "./pty.ts";
import { renderExecCommandCall, renderResult, renderWriteStdinCall } from "./render.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { buildShellCommand, IS_WINDOWS, resolveDefaultShell } from "./shell.ts";
import { unescapeChars } from "./unescape.ts";

// ---------------- Constants (mirror codex) ----------------

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
const DEFAULT_MAX_BACKGROUND_POLL_MS = 1_800_000;
export const MAX_EMPTY_POLL_ENV_VAR = "PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS";
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // onUpdate cadence
const SESSION_UI_KEY = "unified-exec.sessions";

// ---------------- Helpers ----------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

export function resolveMaxEmptyPollMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_EMPTY_POLL_ENV_VAR]?.trim();
	if (!raw) return DEFAULT_MAX_BACKGROUND_POLL_MS;

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BACKGROUND_POLL_MS;
	return Math.max(MIN_EMPTY_YIELD_TIME_MS, Math.floor(parsed));
}

function clampEmptyPollYield(ms: number | undefined): number {
	const v = typeof ms === "number" && ms > 0 ? ms : DEFAULT_WRITE_STDIN_YIELD_MS;
	return clamp(Math.floor(v), MIN_EMPTY_YIELD_TIME_MS, resolveMaxEmptyPollMs());
}

/**
 * Normalize a user/LLM-supplied signal name ("TERM", "sigint", "SIGKILL") to
 * a valid NodeJS.Signals for the current platform. Throws on unknown names so
 * a typo doesn't silently no-op and then escalate to SIGKILL.
 */
function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
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
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	warnedShellFallback: boolean;
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
			`tty: true requires @homebridge/node-pty-prebuilt-multiarch but it failed to load: ${getPtyLoadError() ?? "unknown"}.\n` +
				`Run:  cd .pi/extensions/unified-exec && npm install\n` +
				`Or call with tty: false (default).`,
		);
	}

	let shellBin = args.shell;
	if (!shellBin) {
		const resolved = resolveDefaultShell();
		shellBin = resolved.shell;
		if (resolved.fellBack && !ctx.warnedShellFallback) {
			ctx.warnedShellFallback = true;
			ctx.ui?.notify(
				"unified-exec: bash not found on PATH; falling back to powershell. Install Git Bash for best results.",
				"warning",
			);
		}
	}
	const shellCommand = buildShellCommand(shellBin, args.cmd);
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? args.workdir : cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command: shellCommand.command,
		cwd: effectiveCwd,
		env: process.env,
		tty,
		displayCommand: args.cmd,
		shell: shellBin,
		windowsVerbatimArguments: shellCommand.windowsVerbatimArguments,
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
			// macOS can deliver stdout/stderr shortly after the exit event for very
			// fast commands. Give the trailing drain a bounded but less brittle window.
			deadlineMs: Date.now() + 500,
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
	watchSessionExit(ctx, session);
	if (pruned) {
		unwatchSessionExit(ctx, pruned.id);
		ctx.ui?.notify(`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`, "warning");
	}
	if (count >= WARNING_SESSIONS) {
		ctx.ui?.notify(`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`, "warning");
	}
	// Note: sessions stay in the store until a later tool call observes the
	// exit: write_stdin returns the final exit_code/output, and list_sessions
	// reports exited sessions one last time (with exit info) before removing
	// them. Matches codex's lazy-drain so exit information is never silently
	// lost across turns.

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
	removeSession(ctx, session.id);
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

	let writeFailure: string | null = null;
	if (!isEmptyPoll && writeBytes) {
		const ok = session.write(writeBytes);
		if (!ok && !session.hasExited) {
			// Still running but stdin is gone (child closed it / EPIPE earlier).
			writeFailure = "stdin write failed: the child closed its stdin; bytes were not delivered";
		}
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
			removeSession(ctx, session.id);
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
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage ?? writeFailure,
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
		failure: writeFailure,
		tty: session.tty,
		logPath: session.logPath,
		cwd: session.cwd,
		command: session.displayCommand,
		yieldTimeMs,
	});
}

/** Result of terminating a session via kill_session or the sessions command. */
interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	finalOutput: string;
}

/**
 * Kill a session (initial signal → 2s grace → SIGKILL escalation), drain its
 * trailing output, and remove it from the store. Shared by the kill_session
 * tool and the /unified-exec-sessions command.
 */
async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
): Promise<TerminateOutcome | undefined> {
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	session.kill(initial);
	// Wait up to 2s for exit.
	const exitDeadline = Date.now() + 2000;
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
	removeSession(ctx, sid);
	return { session, escalated, finalOutput: decode(collected) };
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

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return n === 1 ? singular : pluralForm;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

function oneLineCommand(command: string, max = 120): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		`⚠ unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running`,
		...shown.map(
			(s) =>
				`  #${s.id} ${formatElapsed(now - s.startedAt)} ${oneLineCommand(s.displayCommand, 72)} (${s.cwd})`,
		),
	];
	if (sessions.length > shown.length) lines.push(`  … ${sessions.length - shown.length} more; use list_sessions`);
	lines.push("  Use list_sessions for a fresh inventory, write_stdin to poll/drive, or kill_session to stop.");
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length ? `unified-exec: ${sessions.length} ${plural(sessions.length, "session")} running` : undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			`unified-exec: ${sessions.length} ${plural(sessions.length, "session")} still running after /tree.`,
			"warning",
		);
	}

	const setWidget = (ui as any).setWidget as
		| ((key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void)
		| undefined;
	if (!setWidget) return;

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			setWidget.call(ui, SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		setWidget.call(ui, SESSION_UI_KEY, formatRunningSessionsWidget(sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		// Preserve lazy-drain semantics: an exited session stays in the store until
		// write_stdin/list_sessions/kill_session observes it. The UI only reflects
		// currently running processes.
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
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
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		warnedShellFallback: false,
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
		updateRunningSessionsUi(ctx);
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

	pi.on("session_tree", async (_event, eventCtx) => {
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async () => {
		const drained = ctx.store.terminateAll();
		clearSessionExitWatchers(ctx);
		updateRunningSessionsUi(ctx);
		// Children run detached (own process groups), so anything that ignores
		// SIGTERM would outlive pi as an orphan. Give them a short grace, then
		// SIGKILL survivors and wait briefly for confirmation.
		const graceDeadline = Date.now() + 1000;
		while (drained.some((s) => !s.hasExited) && Date.now() < graceDeadline) {
			await sleep(50);
		}
		const survivors = drained.filter((s) => !s.hasExited);
		for (const s of survivors) s.kill("SIGKILL");
		if (survivors.length) {
			const killDeadline = Date.now() + 500;
			while (drained.some((s) => !s.hasExited) && Date.now() < killDeadline) {
				await sleep(25);
			}
		}
		if (drained.length && ctx.ui) {
			ctx.ui.notify(`unified-exec: terminated ${drained.length} live session(s) on shutdown`, "info");
		}
	});

	// Human-facing escape hatch: inspect and kill live sessions without going
	// through the model.
	pi.registerCommand("unified-exec-sessions", {
		description: "List live unified-exec sessions and optionally kill one (or all)",
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			// Reap silently-exited sessions first so the picker only shows live ones.
			for (const s of ctx.store.values()) {
				if (s.hasExited) removeSession(ctx, s.id);
			}
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify("unified-exec: no live sessions", "info");
				return;
			}
			const now = Date.now();
			const labels = sessions.map(
				(s) => `#${s.id} ${formatElapsed(now - s.startedAt)} ${oneLineCommand(s.displayCommand, 60)}`,
			);
			const KILL_ALL = `Kill all ${sessions.length} ${plural(sessions.length, "session")}`;
			const choice = await cmdCtx.ui.select(
				`unified-exec: ${sessions.length} live ${plural(sessions.length, "session")} — select to kill (Esc to cancel)`,
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM");
				if (outcome) killed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(`unified-exec: killed ${killed} ${plural(killed, "session")}`, "info");
		},
	});

	// ---------------- Tools ----------------

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			"Run a command in a persistent session. Returns `session_id` if still running (drive with write_stdin) or `exit_code` if it finished within yield_time_ms.",
		promptSnippet: "Run a shell command; long-running ones yield a session_id",
		promptGuidelines: [
			"Prefer dedicated file tools when available (read/grep/find/ls). Otherwise use exec_command with fast shell tools: rg for content search, fd if available (or find) for file names, and ls for directories.",
			"Use a small yield_time_ms (~500ms) for quick one-shots and the 10s default for most commands; long-running or interactive processes (dev servers, REPLs, ssh, sudo) return a session_id you then drive with write_stdin.",
			`For long-running non-interactive commands, start with a short yield to obtain a session_id, then monitor with one empty write_stdin poll up to the configured cap (default ${DEFAULT_MAX_BACKGROUND_POLL_MS} ms / 30 minutes; set ${MAX_EMPTY_POLL_ENV_VAR}=300000 for cache-sensitive runs) rather than repeated short polls.`,
		],
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
			shell: Type.Optional(
				Type.String({
					description:
						"Shell binary. Defaults to bash (on Windows: bash if on PATH, else powershell). cmd and powershell/pwsh get shell-appropriate flags.",
				}),
			),
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
			updateRunningSessionsUi(ctx);
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
		description:
			"Write bytes to a running session. Omit both chars and chars_b64 to poll without writing. Use `chars` for text with C-style escapes (e.g. \\x03 Ctrl-C, \\x1b ESC, \\n newline); use `chars_b64` for raw binary.",
		promptSnippet: "Send input to or poll a running session",
		promptGuidelines: [
			`For known long-running non-interactive jobs, avoid frequent polling. After exec_command returns a session_id, use write_stdin with no chars/chars_b64 and a long yield_time_ms up to the configured cap (default ${DEFAULT_MAX_BACKGROUND_POLL_MS} ms / 30 minutes).`,
			`Prefer one long empty poll over many short polls to avoid filling the conversation with repeated partial output; for prompt-cache-sensitive runs, set ${MAX_EMPTY_POLL_ENV_VAR}=300000 to keep polls within typical 5-minute cache expiry windows.`,
			"Use long empty polls for builds, test suites, installs, downloads, data processing, and other jobs that do not need interaction.",
			"Do not use long polls for interactive sessions such as REPLs, sudo, ssh, password prompts, or commands where you may need to send input soon.",
			"For very noisy jobs, rely on the log_path and final/truncated output instead of repeatedly polling.",
		],
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session id from exec_command." }),
			chars: Type.Optional(
				Type.String({
					description:
						"Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
				}),
			),
			chars_b64: Type.Optional(
				Type.String({
					description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: `How long (ms) to wait for output before yielding. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}; for empty input clamped to [${MIN_EMPTY_YIELD_TIME_MS}, ${resolveMaxEmptyPollMs()}].`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params as WriteStdinArgs, signal, onUpdate as any);
			updateRunningSessionsUi(ctx);
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
		description:
			"Terminate a session (SIGTERM, escalates to SIGKILL after 2s; on Windows any signal force-kills the process tree). Use when the process won't exit via Ctrl-C. session_id is invalid after.",
		promptSnippet: "Terminate a session",
		parameters: Type.Object({
			session_id: Type.Number({ description: "Session to terminate." }),
			signal: Type.Optional(
				Type.String({ description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const outcome = await terminateSessionById(ctx, sid, initial);
			if (!outcome) {
				return {
					content: [{ type: "text", text: `No such session: ${sid}` }],
					details: { session_id: sid, found: false },
				};
			}
			const { session, escalated, finalOutput: text } = outcome;
			updateRunningSessionsUi(ctx);
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
		promptSnippet: "List live sessions",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			// Reap any sessions that have exited silently (e.g., completed between
			// tool calls without anyone observing them) — but report each of them
			// one final time with exit info instead of dropping them on the floor.
			// This mirrors codex's `refresh_process_state` filter while preserving
			// our "exit information is never silently lost" guarantee.
			const reaped: ExecSession[] = [];
			for (const s of ctx.store.values()) {
				if (s.hasExited) {
					removeSession(ctx, s.id);
					reaped.push(s);
				}
			}
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const live = ctx.store.values();
			const sessions = [...live, ...reaped]
				.sort((a, b) => a.id - b.id)
				.map((s) => ({
					session_id: s.id,
					command: s.displayCommand,
					cwd: s.cwd,
					tty: s.tty,
					pid: s.pid,
					started_at_ms: s.startedAt,
					elapsed_ms: now - s.startedAt,
					running: !s.hasExited,
					exit_code: s.hasExited ? s.exitCode : undefined,
					signal: s.hasExited ? (s.signal ?? undefined) : undefined,
					failure_message: s.failureMessage ?? undefined,
					output_bytes_total: s.totalBytesSeen,
					log_path: s.logPath,
				}));
			const lines = sessions.length
				? sessions.map((s) => {
						const exitedSuffix = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}; removed from store]`;
						return `  ${String(s.session_id).padStart(3)}  pid=${String(s.pid ?? "?").padStart(6)}  ${
							s.tty ? "tty" : "pipe"
						}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}  ${s.command.length > 60 ? s.command.slice(0, 60) + "…" : s.command}${exitedSuffix}\n        log: ${s.log_path}`;
					})
				: ["  (no live sessions)"];
			const header = reaped.length
				? `unified-exec sessions (${live.length} live, ${reaped.length} just exited):`
				: `unified-exec sessions (${live.length}):`;
			return {
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
				details: { sessions, active_count: live.length },
			};
		},
	});
}
