/**
 * Shell selection and command-line construction, cross-platform.
 *
 * On POSIX every shell we care about takes `-c <cmd>`. On Windows the
 * invocation differs per shell (cmd.exe wants `/d /s /c`, PowerShell wants
 * `-Command`), and `bash` may not exist at all — in that case we fall back
 * to `powershell` (with a user-visible warning at the call site).
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

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

/** Build the argv for running `cmd` under the given shell binary. */
export function buildShellCommand(shellBin: string, cmd: string): ShellCommand {
	switch (shellBase(shellBin)) {
		case "cmd":
			// /d skip AutoRun, /s standard quote handling, /c run-and-exit.
			// Verbatim so cmd.exe sees exactly: /d /s /c "<cmd>"
			return { command: [shellBin, "/d", "/s", "/c", `"${cmd}"`], windowsVerbatimArguments: true };
		case "powershell":
		case "pwsh":
			return { command: [shellBin, "-NoProfile", "-Command", cmd] };
		default:
			// bash, sh, zsh, fish, … all take -c.
			return { command: [shellBin, "-c", cmd] };
	}
}

/** Find `bin` on PATH. Windows-aware: tries .exe/.cmd/.bat extensions. */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const pathVar = env.PATH ?? env.Path ?? "";
	const exts = IS_WINDOWS ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const full = join(dir, bin + ext);
			try {
				if (existsSync(full)) return full;
			} catch {
				// unreadable dir — ignore
			}
		}
	}
	return undefined;
}

export interface DefaultShell {
	shell: string;
	/** true when Windows had no bash on PATH and we fell back to powershell. */
	fellBack: boolean;
}

let cachedDefaultShell: DefaultShell | undefined;

/**
 * Default shell when the caller didn't pass one: `bash` everywhere. On
 * Windows without bash on PATH (no Git Bash / WSL), fall back to
 * `powershell`. Result is cached for the process lifetime.
 */
export function resolveDefaultShell(): DefaultShell {
	if (!IS_WINDOWS) return { shell: "bash", fellBack: false };
	if (!cachedDefaultShell) {
		cachedDefaultShell = findOnPath("bash")
			? { shell: "bash", fellBack: false }
			: { shell: "powershell", fellBack: true };
	}
	return cachedDefaultShell;
}

/** Test hook: forget the cached default-shell probe. */
export function resetDefaultShellCache(): void {
	cachedDefaultShell = undefined;
}
