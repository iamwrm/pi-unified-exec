/**
 * Shell selection and command-line construction, cross-platform.
 *
 * On POSIX every shell we care about takes `-c <cmd>`. On Windows the
 * invocation differs per shell (cmd.exe wants `/d /s /c`, PowerShell wants
 * `-Command`), and `bash` may not exist at all — in that case we fall back
 * to `powershell` (with a user-visible warning at the call site).
 */

import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** Executable extensions probed on Windows (PATHEXT order), plus bare. */
const WINDOWS_EXEC_EXTS = [".com", ".exe", ".bat", ".cmd", ""];

/**
 * Extensions valid for a SHELL binary. Only formats CreateProcess runs
 * directly: Node refuses to spawn .bat/.cmd without shell:true
 * (CVE-2024-27980 hardening), so resolving a shell to a .cmd wrapper would
 * produce an unspawnable EINVAL path.
 */
const WINDOWS_SHELL_EXTS = [".com", ".exe"];

/** %SystemRoot%\System32 path builder with a sane fallback. */
function system32(...parts: string[]): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return join(root, "System32", ...parts);
}

export interface ShellCommand {
	command: string[];
	/**
	 * Pass args to the OS verbatim (no Node re-quoting). Required for
	 * cmd.exe, whose quoting rules CreateProcess-style escaping mangles.
	 */
	windowsVerbatimArguments?: boolean;
}

/** Basename without a Windows executable extension, lowercased. */
function shellBase(shellBin: string): string {
	const base = shellBin.split(/[\\/]/).pop() ?? shellBin;
	return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * Build the argv for running `cmd` under the given shell binary.
 * `isWindows` is a parameter (defaulting to the real platform) so tests can
 * exercise both branches anywhere.
 */
export function buildShellCommand(shellBin: string, cmd: string, isWindows: boolean = IS_WINDOWS): ShellCommand {
	const base = shellBase(shellBin);
	// cmd.exe specialization only applies on Windows — a POSIX binary that
	// happens to be named `cmd` must get the uniform `-c` treatment.
	if (isWindows && base === "cmd") {
		if (/[\r\n]/.test(cmd)) {
			// cmd.exe /c silently stops at the first newline, executing only
			// the first line — fail closed rather than silently truncate.
			throw new Error(
				'cmd.exe cannot run multiline commands via /c (everything after the first line is silently dropped). Join lines with " & ", or use shell: "powershell" or bash.',
			);
		}
		// /d skip AutoRun, /s standard quote handling, /c run-and-exit.
		// Verbatim so cmd.exe sees exactly: /d /s /c "<cmd>"
		return { command: [shellBin, "/d", "/s", "/c", `"${cmd}"`], windowsVerbatimArguments: true };
	}
	// powershell/pwsh take -Command on every platform (pwsh is cross-platform).
	if (base === "powershell" || base === "pwsh") {
		return { command: [shellBin, "-NoProfile", "-Command", cmd] };
	}
	// bash, sh, zsh, fish, … all take -c.
	return { command: [shellBin, "-c", cmd] };
}

export interface FindOnPathOptions {
	/** Extensions to probe, in order. Defaults per-platform. */
	exts?: string[];
	/** Skip matches whose full path matches this pattern. */
	exclude?: RegExp;
}

/**
 * Find `bin` on PATH and return its absolute path. Windows-aware: tries
 * .exe/.cmd/.bat extensions. Only regular files count (a directory named
 * like the binary is skipped).
 */
export function findOnPath(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	opts: FindOnPathOptions = {},
): string | undefined {
	const pathVar = env.PATH ?? env.Path ?? "";
	const exts = opts.exts ?? (IS_WINDOWS ? WINDOWS_EXEC_EXTS : [""]);
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			// resolve() (not join): a relative PATH entry must not yield a
			// cwd-dependent result that breaks when spawned from another cwd.
			const full = resolve(dir, bin + ext);
			if (opts.exclude?.test(full)) continue;
			try {
				if (statSync(full).isFile()) return full;
			} catch {
				// missing or unreadable — keep scanning
			}
		}
	}
	return undefined;
}

export interface DefaultShell {
	/** Shell to spawn. Absolute path when resolved from PATH. */
	shell: string;
	/** true when Windows had no usable bash and we fell back to powershell. */
	fellBack: boolean;
}

/** System32's bash.exe is the WSL stub — a different OS view entirely. */
const SYSTEM32_RE = /[\\/]system32[\\/]/i;

/**
 * The Windows default-shell probe: prefer a real bash (Git Bash / MSYS2),
 * excluding System32's WSL stub (it runs commands inside a WSL distro — or
 * errors out when none is installed — while looking like a normal bash).
 * Falls back to powershell. Exported separately from resolveDefaultShell so
 * tests can drive it with a synthetic PATH on any platform.
 */
export function probeWindowsDefaultShell(
	env: NodeJS.ProcessEnv,
	exts: string[] = WINDOWS_EXEC_EXTS,
): DefaultShell {
	const bash = findOnPath("bash", env, { exts, exclude: SYSTEM32_RE });
	if (bash) return { shell: bash, fellBack: false };
	const powershell = findOnPath("powershell", env, { exts });
	// Last resort: the canonical absolute location, never a bare name — a
	// bare name would let Windows' cwd-first lookup execute a
	// powershell.exe planted in an untrusted workdir.
	return {
		shell: powershell ?? system32("WindowsPowerShell", "v1.0", "powershell.exe"),
		fellBack: true,
	};
}

let cachedDefaultShell: DefaultShell | undefined;

/**
 * Default shell when the caller didn't pass one: `bash` everywhere. On
 * Windows the probe result (absolute path) is cached for the process
 * lifetime; passing an explicit `env` bypasses the cache (test hook).
 */
export function resolveDefaultShell(env?: NodeJS.ProcessEnv): DefaultShell {
	if (!IS_WINDOWS) return { shell: "bash", fellBack: false };
	if (env) return probeWindowsDefaultShell(env);
	if (!cachedDefaultShell) cachedDefaultShell = probeWindowsDefaultShell(process.env);
	return cachedDefaultShell;
}

const resolvedBinaryCache = new Map<string, string>();

/**
 * Resolve a bare binary name to an absolute path via PATH, with caching.
 * Names that already contain a directory component pass through untouched,
 * as do names that can't be resolved (the spawn will surface the error).
 *
 * Spawning the resolved absolute path (instead of the bare name) keeps the
 * probed binary and the spawned binary identical, and avoids Windows'
 * CreateProcess cwd-first lookup — a `bash.exe` planted in an untrusted
 * workdir must not shadow the real shell.
 */
export function resolveBinary(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin;
	if (env) return findOnPath(bin, env) ?? bin; // test hook: no caching
	const cached = resolvedBinaryCache.get(bin);
	if (cached) return cached;
	const resolved = findOnPath(bin) ?? bin;
	resolvedBinaryCache.set(bin, resolved);
	return resolved;
}

/**
 * Resolve a Windows SHELL binary to an absolute path, failing closed.
 *
 * Unlike resolveBinary, an unresolvable bare name throws instead of passing
 * through: spawning a bare name lets CreateProcess check the child's cwd
 * (the LLM-supplied workdir) first, so "powershell" with a mangled PATH
 * would happily execute an attacker's powershell.exe from an untrusted
 * repo. Only .com/.exe are accepted (Node can't spawn .cmd/.bat directly).
 */
export function resolveWindowsShell(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin; // explicit path: caller's responsibility
	if (!env) {
		const cached = resolvedBinaryCache.get(`shell:${bin}`);
		if (cached) return cached;
	}
	const found = findOnPath(bin, env ?? process.env, { exts: WINDOWS_SHELL_EXTS });
	if (!found) {
		throw new Error(
			`shell "${bin}" not found on PATH (searched ${WINDOWS_SHELL_EXTS.join("/")}). Pass an absolute path, or use "powershell" / "cmd" / an installed bash.`,
		);
	}
	if (!env) resolvedBinaryCache.set(`shell:${bin}`, found);
	return found;
}

/** Test hook: forget cached shell/binary probes. */
export function resetDefaultShellCache(): void {
	cachedDefaultShell = undefined;
	resolvedBinaryCache.clear();
}
