/**
 * Unit tests for src/shell.ts: shell command construction, PATH lookup,
 * and the Windows bash→powershell default-shell fallback.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildShellCommand, findOnPath, IS_WINDOWS, resolveDefaultShell } from "../src/shell.ts";

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
		const found = findOnPath("node");
		assert.ok(found, "expected node to be found on PATH");
	});

	it("returns undefined for a nonexistent binary", () => {
		assert.equal(findOnPath("definitely-not-a-real-binary-12345"), undefined);
	});

	it("respects a custom env PATH", () => {
		assert.equal(findOnPath("node", { PATH: "" }), undefined);
	});
});

describe("resolveDefaultShell", () => {
	it("returns bash on POSIX; bash or powershell on Windows", () => {
		const r = resolveDefaultShell();
		if (IS_WINDOWS) {
			assert.ok(r.shell === "bash" || r.shell === "powershell");
			// fellBack iff bash was not found
			assert.equal(r.fellBack, r.shell === "powershell");
		} else {
			assert.deepEqual(r, { shell: "bash", fellBack: false });
		}
	});
});
