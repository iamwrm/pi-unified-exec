/**
 * Unified spawn: PTY (via node-pty-prebuilt-multiarch) or plain pipes.
 *
 * Presents a single `SpawnedChild` abstraction used by `session.ts` regardless
 * of underlying mode. Mirrors codex's `codex_utils_pty::pty` (tty=true) and
 * `codex_utils_pty::pipe` (tty=false).
 */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

export interface SpawnOptions {
	command: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	tty: boolean;
	cols?: number;
	rows?: number;
}

/**
 * Signature for the "something exited" callback. `exitCode` may be null when
 * killed by a signal (and `signal` is set in that case).
 */
export type ExitCallback = (exitCode: number | null, signal: NodeJS.Signals | null) => void;

export interface SpawnedChild {
	readonly pid: number | undefined;
	readonly tty: boolean;
	/** Write raw bytes to the child's stdin (or PTY input side). */
	write(data: Uint8Array): boolean;
	/** Subscribe to data chunks (combined stdout+stderr). Returns unsubscribe. */
	onData(handler: (chunk: Uint8Array) => void): () => void;
	/** Subscribe to the child's exit event. Fires at most once. */
	onExit(handler: ExitCallback): void;
	/** Send a signal to the process group; silently no-ops if already dead. */
	kill(signal?: NodeJS.Signals): void;
	/** Resize the PTY if applicable; no-op for pipe mode. */
	resize(cols: number, rows: number): void;
}

// ---------------- PTY loader (best-effort) ----------------

type PtyModule = {
	spawn: (
		file: string,
		args: string[],
		opts: {
			name?: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			encoding?: null | string;
		},
	) => PtyProcess;
};

type PtyProcess = {
	pid: number;
	onData: (cb: (data: string | Buffer) => void) => { dispose: () => void };
	onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
	write: (data: string | Buffer) => void;
	resize: (cols: number, rows: number) => void;
	kill: (signal?: string) => void;
};

let ptyModule: PtyModule | null | undefined;
let ptyLoadError: string | undefined;

export function getPtyLoadError(): string | undefined {
	loadPty();
	return ptyLoadError;
}

export function isPtyAvailable(): boolean {
	loadPty();
	return !!ptyModule;
}

function loadPty(): void {
	if (ptyModule !== undefined) return; // already attempted
	try {
		// Use createRequire so CJS-only native modules work under ESM + jiti.
		const req = createRequire(import.meta.url);
		ptyModule = req("node-pty-prebuilt-multiarch") as PtyModule;
		ptyLoadError = undefined;
	} catch (err: any) {
		ptyModule = null;
		ptyLoadError = err?.message ?? String(err);
	}
}

// Numeric signal → name, so our ExitCallback always reports SIG* strings.
const SIGNAL_NAMES: Record<number, NodeJS.Signals> = {
	1: "SIGHUP",
	2: "SIGINT",
	3: "SIGQUIT",
	6: "SIGABRT",
	9: "SIGKILL",
	15: "SIGTERM",
};

/** Spawn a child with PTY or pipes. Throws if PTY requested but unavailable. */
export function spawnChild(opts: SpawnOptions): SpawnedChild {
	if (opts.tty) {
		loadPty();
		if (!ptyModule) {
			throw new Error(
				`tty: true requires node-pty-prebuilt-multiarch, but it failed to load: ${ptyLoadError ?? "unknown error"}.\n` +
					`Install it with:  cd .pi/extensions/unified-exec && npm install\n` +
					`Or call with tty: false to use pipes instead.`,
			);
		}
		return spawnPty(ptyModule, opts);
	}
	return spawnPipes(opts);
}

// ---------------- PTY impl ----------------

function spawnPty(mod: PtyModule, opts: SpawnOptions): SpawnedChild {
	const [file, ...args] = opts.command;
	if (!file) throw new Error("spawnChild: empty command");
	const child = mod.spawn(file, args, {
		cwd: opts.cwd,
		env: opts.env,
		cols: opts.cols ?? 120,
		rows: opts.rows ?? 30,
		name: "xterm-256color",
	});

	const dataHandlers = new Set<(chunk: Uint8Array) => void>();
	const exitHandlers = new Set<ExitCallback>();
	let exited = false;

	const dataSub = child.onData((data) => {
		const chunk = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		for (const h of dataHandlers) {
			try {
				h(chunk);
			} catch {
				// ignore handler errors
			}
		}
	});
	const exitSub = child.onExit(({ exitCode, signal }) => {
		if (exited) return;
		exited = true;
		dataSub?.dispose?.();
		exitSub?.dispose?.();
		const sigName = signal != null ? (SIGNAL_NAMES[signal] ?? null) : null;
		for (const h of exitHandlers) {
			try {
				h(sigName ? null : (exitCode ?? 0), sigName);
			} catch {
				// ignore
			}
		}
		exitHandlers.clear();
		dataHandlers.clear();
	});

	return {
		pid: child.pid,
		tty: true,
		write(data) {
			if (exited) return false;
			try {
				child.write(Buffer.from(data));
				return true;
			} catch {
				return false;
			}
		},
		onData(handler) {
			dataHandlers.add(handler);
			return () => dataHandlers.delete(handler);
		},
		onExit(handler) {
			if (exited) return;
			exitHandlers.add(handler);
		},
		kill(signal = "SIGTERM") {
			if (exited) return;
			try {
				child.kill(signal);
			} catch {
				// already gone
			}
		},
		resize(cols, rows) {
			if (exited) return;
			try {
				child.resize(cols, rows);
			} catch {
				// ignore
			}
		},
	};
}

// ---------------- Pipes impl ----------------

function spawnPipes(opts: SpawnOptions): SpawnedChild {
	const [file, ...args] = opts.command;
	if (!file) throw new Error("spawnChild: empty command");
	const child: ChildProcess = cpSpawn(file, args, {
		cwd: opts.cwd,
		env: opts.env,
		detached: true, // own process group so we can `kill -pid`
		stdio: ["pipe", "pipe", "pipe"],
	});

	const dataHandlers = new Set<(chunk: Uint8Array) => void>();
	const exitHandlers = new Set<ExitCallback>();
	let exited = false;

	const onChunk = (chunk: Buffer) => {
		const view = new Uint8Array(chunk);
		for (const h of dataHandlers) {
			try {
				h(view);
			} catch {
				// ignore
			}
		}
	};
	child.stdout?.on("data", onChunk);
	child.stderr?.on("data", onChunk);

	const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
		if (exited) return;
		exited = true;
		for (const h of exitHandlers) {
			try {
				h(code, signal);
			} catch {
				// ignore
			}
		}
		exitHandlers.clear();
		dataHandlers.clear();
	};
	child.once("exit", (code, signal) => finalize(code, signal));
	child.once("error", (err) => {
		// error → force an "exit" notification so callers don't hang.
		finalize(null, null);
		// Swallow by default; runtime callers can detect via finalize path.
		void err;
	});

	return {
		pid: child.pid,
		tty: false,
		write(data) {
			if (exited || !child.stdin || child.stdin.destroyed) return false;
			return child.stdin.write(Buffer.from(data));
		},
		onData(handler) {
			dataHandlers.add(handler);
			return () => dataHandlers.delete(handler);
		},
		onExit(handler) {
			if (exited) return;
			exitHandlers.add(handler);
		},
		kill(signal = "SIGTERM") {
			if (exited || !child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				try {
					process.kill(child.pid, signal);
				} catch {
					// already gone
				}
			}
		},
		resize() {
			// no-op in pipe mode
		},
	};
}
