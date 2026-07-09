/**
 * Unit tests for src/shell.ts: shell command construction, PATH lookup,
 * and the Windows bash→powershell default-shell fallback.
 *
 * PATH-lookup and probe tests build synthetic PATH directories under a temp
 * dir and inject them via the env parameter, so both probe branches run on
 * every platform (Windows-style .exe probing works anywhere — it's just a
 * filename suffix).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	buildShellCommand,
	findOnPath,
	IS_WINDOWS,
	probeWindowsDefaultShell,
	resolveBinary,
	resolveDefaultShell,
	resetDefaultShellCache,
} from "../src/shell.ts";

const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

/** Create a synthetic PATH dir containing the given (regular) files. */
const tempRoots: string[] = [];
function makePathDir(name: string, files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), `uexec-shell-${name}-`));
	tempRoots.push(dir);
	for (const f of files) {
		const full = join(dir, f);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "");
	}
	return dir;
}

after(() => {
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
	resetDefaultShellCache();
});

describe("buildShellCommand", () => {
	it("POSIX shells get -c", () => {
		assert.deepEqual(buildShellCommand("bash", "echo hi").command, ["bash", "-c", "echo hi"]);
		assert.deepEqual(buildShellCommand("sh", "ls").command, ["sh", "-c", "ls"]);
		assert.deepEqual(buildShellCommand("zsh", "ls").command, ["zsh", "-c", "ls"]);
		assert.equal(buildShellCommand("bash", "echo hi").windowsVerbatimArguments, undefined);
	});

	it("absolute bash path still gets -c", () => {
		const r = buildShellCommand("/usr/bin/bash", "echo hi");
		assert.deepEqual(r.command, ["/usr/bin/bash", "-c", "echo hi"]);
	});

	it("Windows bash.exe path gets -c (extension and case insensitive)", () => {
		const r = buildShellCommand("C:\\Program Files\\Git\\bin\\BASH.EXE", "echo hi");
		assert.deepEqual(r.command, ["C:\\Program Files\\Git\\bin\\BASH.EXE", "-c", "echo hi"]);
	});

	it("powershell and pwsh get -NoProfile -Command", () => {
		assert.deepEqual(buildShellCommand("powershell", "Get-Date").command, [
			"powershell",
			"-NoProfile",
			"-Command",
			"Get-Date",
		]);
		assert.deepEqual(buildShellCommand("pwsh", "Get-Date").command, ["pwsh", "-NoProfile", "-Command", "Get-Date"]);
		assert.deepEqual(buildShellCommand("powershell.exe", "Get-Date").command, [
			"powershell.exe",
			"-NoProfile",
			"-Command",
			"Get-Date",
		]);
	});

	it("cmd gets /d /s /c with a quoted command and verbatim args", () => {
		const r = buildShellCommand("cmd", "dir /b");
		assert.deepEqual(r.command, ["cmd", "/d", "/s", "/c", '"dir /b"']);
		assert.equal(r.windowsVerbatimArguments, true);
		const r2 = buildShellCommand("cmd.exe", "echo hi");
		assert.deepEqual(r2.command, ["cmd.exe", "/d", "/s", "/c", '"echo hi"']);
	});
});

describe("findOnPath", () => {
	it("finds node (present in every test environment)", () => {
		assert.ok(findOnPath("node"), "expected node to be found on PATH");
	});

	it("returns undefined for a nonexistent binary or empty PATH", () => {
		assert.equal(findOnPath("definitely-not-a-real-binary-12345"), undefined);
		assert.equal(findOnPath("node", { PATH: "" }), undefined);
	});

	it("probes Windows extensions in order (.exe before .cmd before bare)", () => {
		const dir = makePathDir("exts", ["tool.exe", "tool.cmd", "tool"]);
		const found = findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS });
		assert.equal(found, join(dir, "tool.exe"));
	});

	it("falls through extensions to the bare name", () => {
		const dir = makePathDir("bare", ["tool"]);
		assert.equal(findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS }), join(dir, "tool"));
	});

	it("earlier PATH entries win", () => {
		const first = makePathDir("first", ["tool.exe"]);
		const second = makePathDir("second", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: first + delimiter + second }, { exts: WIN_EXTS });
		assert.equal(found, join(first, "tool.exe"));
	});

	it("skips directories that match the name (only regular files count)", () => {
		const trap = mkdtempSync(join(tmpdir(), "uexec-shell-dirtrap-"));
		tempRoots.push(trap);
		mkdirSync(join(trap, "tool.exe")); // a DIRECTORY named tool.exe
		const real = makePathDir("real", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: trap + delimiter + real }, { exts: WIN_EXTS });
		assert.equal(found, join(real, "tool.exe"));
	});

	it("honors the exclude pattern", () => {
		const excluded = makePathDir("excl", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: excluded }, { exts: WIN_EXTS, exclude: /uexec-shell-excl/ });
		assert.equal(found, undefined);
	});
});

describe("probeWindowsDefaultShell", () => {
	it("prefers bash when on PATH (absolute path, fellBack=false)", () => {
		const bashDir = makePathDir("gitbash", ["bash.exe"]);
		const psDir = makePathDir("ps1", ["powershell.exe"]);
		const r = probeWindowsDefaultShell({ PATH: bashDir + delimiter + psDir });
		assert.deepEqual(r, { shell: join(bashDir, "bash.exe"), fellBack: false });
	});

	it("skips System32's WSL bash stub and falls back to powershell", () => {
		const sys32 = makePathDir("sys", ["System32/bash.exe", "System32/powershell.exe"]);
		const r = probeWindowsDefaultShell({ PATH: join(sys32, "System32") });
		assert.equal(r.fellBack, true);
		assert.equal(r.shell, join(sys32, "System32", "powershell.exe"));
	});

	it("falls back to bare 'powershell' when nothing is on PATH", () => {
		assert.deepEqual(probeWindowsDefaultShell({ PATH: "" }), { shell: "powershell", fellBack: true });
	});
});

describe("resolveDefaultShell", () => {
	it("returns bash on POSIX without probing", () => {
		if (IS_WINDOWS) return;
		assert.deepEqual(resolveDefaultShell(), { shell: "bash", fellBack: false });
		assert.deepEqual(resolveDefaultShell({ PATH: "" }), { shell: "bash", fellBack: false });
	});

	it("Windows: explicit env bypasses the cache; default env is cached", () => {
		if (!IS_WINDOWS) return;
		resetDefaultShellCache();
		const bashDir = makePathDir("cache", ["bash.exe"]);
		// env-injected calls see their own PATH...
		assert.equal(resolveDefaultShell({ PATH: bashDir }).shell, join(bashDir, "bash.exe"));
		assert.equal(resolveDefaultShell({ PATH: "" }).fellBack, true);
		// ...and the cached default probe returns a stable object.
		const a = resolveDefaultShell();
		const b = resolveDefaultShell();
		assert.deepEqual(a, b);
		resetDefaultShellCache();
	});
});

describe("resolveBinary", () => {
	it("passes through names with a directory component", () => {
		assert.equal(resolveBinary("/usr/bin/bash"), "/usr/bin/bash");
		assert.equal(resolveBinary("C:\\tools\\thing.exe"), "C:\\tools\\thing.exe");
	});

	it("resolves bare names via the provided env PATH", () => {
		const dir = makePathDir("rb", IS_WINDOWS ? ["mytool.exe"] : ["mytool"]);
		assert.equal(resolveBinary("mytool", { PATH: dir }), join(dir, IS_WINDOWS ? "mytool.exe" : "mytool"));
	});

	it("returns the bare name when unresolvable", () => {
		assert.equal(resolveBinary("definitely-not-real-98765", { PATH: "" }), "definitely-not-real-98765");
	});
});
