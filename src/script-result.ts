/**
 * Script-facing results for Pi codemode.
 *
 * Pi 0.99 codemode hands a nested tool call's `structuredContent` to the script
 * when the tool declares an `outputSchema`; otherwise the script receives the
 * whole text envelope as one string. Printing that string inside an object
 * (`text({ ...r })`) serializes every newline as `\n`, producing one logical
 * line that codemode's five-line collapsed preview cannot bound.
 *
 * These projections give scripts `output` as a real multi-line string plus
 * typed state (`exit_code`, `session_id`, …). They derive only from the
 * already-bounded, sanitized result details, so they add no new size or
 * terminal-safety surface. Model-visible `content` and persisted `details`
 * are unchanged.
 */

import { Type, type Static } from "typebox";

import type { OnExitPolicy } from "./completion.ts";
import { type KillResultDetails, type ProcessResultDetails, safeMeta } from "./tool-result.ts";

const optionalMeta = (value: string | undefined): string | undefined => (value ? safeMeta(value) : undefined);

/** Drop undefined fields so the value is plain JSON. */
function compact<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

const outputFields = {
	output: Type.String({
		description:
			"Bounded, terminal-safe tail of the child output with real newlines. Print it with text(r.output) rather than printing the whole result object.",
	}),
	truncated: Type.Boolean({ description: "True when earlier output was dropped; the full stream is in log_path." }),
	omitted_bytes: Type.Optional(Type.Number({ description: "Middle bytes dropped by the in-memory retention cap." })),
	exit_code: Type.Optional(Type.Number({ description: "Exit code once the process has exited." })),
	signal: Type.Optional(Type.String({ description: "Signal that terminated the process, if any." })),
	failure_message: Type.Optional(Type.String()),
	log_path: Type.Optional(Type.String({ description: "File containing the complete output stream." })),
	wall_time_seconds: Type.Number(),
};

export const processScriptResultSchema = Type.Object({
	status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
	running: Type.Boolean(),
	session_id: Type.Optional(
		Type.Number({ description: "Present while the process is still running; drive it with write_stdin." }),
	),
	...outputFields,
	note: Type.Optional(Type.String()),
	wait_status: Type.Optional(Type.String()),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
	tool_time_utc: Type.Optional(Type.String({ description: "Host UTC time, for computing yield_until deadlines." })),
});
export type ProcessScriptResult = Static<typeof processScriptResultSchema>;

export function processScriptResult(shape: ProcessResultDetails): ProcessScriptResult {
	return compact({
		status: shape.status,
		running: shape.running,
		session_id: shape.session_id,
		output: shape.output,
		truncated: shape.truncation?.truncated === true,
		omitted_bytes: shape.omitted_bytes || undefined,
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		log_path: optionalMeta(shape.log_path),
		wall_time_seconds: shape.wall_time_seconds,
		note: optionalMeta(shape.note),
		wait_status: shape.wait_status,
		on_exit: shape.on_exit,
		tool_time_utc: shape.tool_time_utc,
	});
}

export const killScriptResultSchema = Type.Object({
	status: Type.Union([Type.Literal("killed"), Type.Literal("kill_failed")]),
	found: Type.Boolean({ description: "False when no session had this id." }),
	killed: Type.Boolean(),
	running: Type.Boolean({ description: "True when the kill was not confirmed and the session remains registered." }),
	escalated: Type.Boolean({ description: "True when SIGKILL escalation was needed." }),
	session_id: Type.Number(),
	...outputFields,
});
export type KillScriptResult = Static<typeof killScriptResultSchema>;

export function killScriptResult(shape: KillResultDetails): KillScriptResult {
	return compact({
		status: shape.status,
		found: true,
		killed: shape.killed,
		running: shape.running,
		escalated: shape.escalated,
		session_id: shape.session_id,
		output: shape.output,
		truncated: shape.truncation?.truncated === true,
		omitted_bytes: shape.omitted_bytes || undefined,
		exit_code: shape.exit_code,
		signal: optionalMeta(shape.signal),
		failure_message: optionalMeta(shape.failure_message),
		log_path: optionalMeta(shape.log_path),
		wall_time_seconds: shape.wall_time_seconds,
	});
}

export function killNotFoundScriptResult(sessionId: number): KillScriptResult {
	return {
		status: "kill_failed",
		found: false,
		killed: false,
		running: false,
		escalated: false,
		session_id: sessionId,
		output: "",
		truncated: false,
		wall_time_seconds: 0,
	};
}

export const setOnExitScriptResultSchema = Type.Object({
	session_id: Type.Number(),
	found: Type.Boolean({ description: "False when no session or pending wake had this id." }),
	on_exit: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("wake")])),
	status: Type.Optional(Type.String()),
	running: Type.Optional(Type.Boolean()),
	wake_armed: Type.Optional(Type.Boolean()),
});
export type SetOnExitScriptResult = Static<typeof setOnExitScriptResultSchema>;

export function setOnExitScriptResult(value: {
	session_id: number;
	found: boolean;
	on_exit?: OnExitPolicy;
	status?: string;
	running?: boolean;
	wake_armed?: boolean;
}): SetOnExitScriptResult {
	return compact({ ...value });
}

export const listSessionsScriptResultSchema = Type.Object({
	sessions: Type.Array(
		Type.Object({
			session_id: Type.Number(),
			command: Type.String(),
			cwd: Type.Optional(Type.String()),
			tty: Type.Boolean(),
			pid: Type.Optional(Type.Number()),
			elapsed_ms: Type.Number(),
			running: Type.Boolean({ description: "False for sessions that just exited; they are removed after this listing." }),
			wake_armed: Type.Boolean(),
			exit_code: Type.Optional(Type.Number()),
			signal: Type.Optional(Type.String()),
			log_path: Type.Optional(Type.String()),
		}),
	),
	active_count: Type.Number(),
	just_exited_count: Type.Number(),
	tool_time_utc: Type.String(),
});
export type ListSessionsScriptResult = Static<typeof listSessionsScriptResultSchema>;

export function listSessionsScriptResult(value: {
	sessions: ReadonlyArray<{
		session_id: number;
		command: string;
		cwd?: string;
		tty: boolean;
		pid?: number;
		elapsed_ms: number;
		running: boolean;
		wake_armed: boolean;
		exit_code?: number | null;
		signal?: string;
		log_path?: string;
	}>;
	active_count: number;
	just_exited_count: number;
	tool_time_utc: string;
}): ListSessionsScriptResult {
	return {
		sessions: value.sessions.map((s) =>
			compact({
				session_id: s.session_id,
				command: safeMeta(s.command),
				cwd: optionalMeta(s.cwd),
				tty: s.tty,
				pid: s.pid,
				elapsed_ms: s.elapsed_ms,
				running: s.running,
				wake_armed: s.wake_armed,
				exit_code: s.exit_code ?? undefined,
				signal: optionalMeta(s.signal),
				log_path: optionalMeta(s.log_path),
			}),
		),
		active_count: value.active_count,
		just_exited_count: value.just_exited_count,
		tool_time_utc: value.tool_time_utc,
	};
}
