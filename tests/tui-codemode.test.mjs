import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const available = spawnSync("tmux", ["-V"]).status === 0;
const cli = process.env.PI_UNIFIED_EXEC_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/codemode-provider.js", import.meta.url));
const envKey = "PI_UNIFIED_EXEC_COMPACT_CODEMODE";
const socket = `exec-codemode-${process.pid}`;
const pause = ms => new Promise(done => setTimeout(done, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const tmux = (...args) => {
	const child = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
	assert.equal(child.status, 0, child.stderr);
	return child.stdout;
};
const alive = pid => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};
const capture = name => tmux("capture-pane", "-p", "-t", name);
async function completed(name) {
	for (let i = 0; i < 150; i++) {
		if (capture(name).includes("EXEC_CODEMODE_OK")) { await pause(150); return capture(name); }
		await pause(100);
	}
	assert.fail(`Codemode never completed:\n${capture(name)}`);
}
function resultBody(text, toolName) {
	const lines = text.split("\n");
	const start = lines.findLastIndex(line => new RegExp(`^\\s*✓ ${toolName}\\b`).test(line));
	assert.ok(start >= 0, text);
	const end = lines.findIndex((line, i) => i > start && /^\s*EXEC_CODEMODE_OK\s*$/.test(line));
	assert.ok(end > start, text);
	const body = lines.slice(start, end);
	while (body.length && !body.at(-1).trim()) body.pop();
	return body;
}
let serial = 0;
async function run({ fixed = true, width = 100, pattern = "A", mode = "regular", disableNative = fixed, theme = "dark" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-exec-codemode-tui-"));
	const name = `case-${serial++}`;
	let started = false;
	let pid;
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false,
			defaultTools: ["+codemode"], extensions: disableNative ? ["-builtin:codemode"] : [],
		}));
		// Fixed cases have NO opt-in setting: remove any inherited opt-out.
		const argv = ["env", "-u", envKey, `HOME=${root}`, `TMPDIR=${root}`, `PI_CODING_AGENT_DIR=${agentDir}`, "PI_OFFLINE=1", `EXEC_CODEMODE_PATTERN=${pattern}`,
			...(fixed ? [] : [`${envKey}=0`]), process.execPath, cli, "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--tui-mode", mode, "--use-theme", theme, "-e", provider, "-e", extension,
			"--provider", "exec-codemode-offline", "--model", "codemode-model", "--thinking", "off", "run fixture",
		];
		tmux("new-session", "-d", "-s", name, "-x", String(width), "-y", "60", "-c", root, "exec " + argv.map(quote).join(" "));
		started = true;
		pid = Number(tmux("display-message", "-p", "-t", name, "#{pane_pid}").trim());
		const collapsed = await completed(name);
		assert.doesNotMatch(collapsed, /Script (completed|failed)/, "a renderer exception must not be hidden by Pi's fallback");
		if (disableNative) assert.doesNotMatch(collapsed, /was not loaded|registers tool/);
		else if (fixed) assert.match(collapsed, /was not loaded|not loaded/);
		const toolName = pattern === "spill" ? "sample" : "exec_command";
		const body = resultBody(collapsed, toolName);
		// The native result also owns one blank row before the call summaries.
		if (fixed) assert.ok(body.length + 1 <= 10, `${body.length + 1} result rows:\n${collapsed}`);
		else if (["A", "B"].includes(pattern)) assert.ok(body.length + 1 > 10, "opt-out must restore the unbounded native preview");
		if (fixed && ["A", "B"].includes(pattern)) assert.match(body.join("\n"), /to expand \(clipped\)/);
		if (pattern === "C" && width === 100) assert.match(body.join("\n"), /36 more lines, ctrl\+o to expand/);
		if (pattern === "spill") assert.match(body.at(-1), /Full output:/);
		tmux("send-keys", "-t", name, "C-o");
		await pause(350);
		const expanded = capture(name);
		assert.doesNotMatch(expanded, /to expand \(clipped\)|Script (completed|failed)/);
		assert.match(expanded.replaceAll("\n", ""), /number 40/);
		tmux("send-keys", "-t", name, "C-o");
		await pause(350);
		const recollapsed = capture(name);
		assert.doesNotMatch(recollapsed, /Script (completed|failed)/);
		assert.deepEqual(resultBody(recollapsed, toolName), body);
	} finally {
		if (started) { try { tmux("kill-session", "-t", name); } catch {} }
		// Pi flushes its Node compile cache on exit. Do not remove TMPDIR while
		// that owned process is still writing; otherwise cleanup can race it.
		for (let i = 0; pid && alive(pid) && i < 30; i++) await pause(100);
		if (pid) assert.ok(!alive(pid), "fixture process survived tmux shutdown");
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}
const options = { skip: !available || process.platform === "win32", timeout: 30_000 };
for (const pattern of ["A", "B", "C"]) {
	test(`codemode TUI: native opt-out ${pattern}, 100x60`, options, () => run({ fixed: false, pattern }));
	for (const width of [40, 80, 100]) test(`codemode TUI: default-on ${pattern}, ${width}x60`, options, () => run({ pattern, width }));
}
for (const pattern of ["A", "B", "C"]) test(`codemode TUI: ${pattern}, fullscreen 80x60`, options, () => run({ pattern, width: 80, mode: "fullscreen" }));
test("codemode TUI: clipping retains full-output recovery footer", options, () => run({ pattern: "spill", width: 80 }));
test("codemode TUI: duplicate built-in warning without exclusion", options, () => run({ disableNative: false }));
for (const theme of ["system", "light"]) test(`codemode TUI: default-on ${theme} theme`, options, () => run({ theme }));
