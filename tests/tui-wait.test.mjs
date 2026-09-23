import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const available = spawnSync("tmux", ["-V"]).status === 0;
const cli = process.env.PI_UNIFIED_EXEC_TEST_CLI ?? fileURLToPath(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/wait-provider.js", import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await pause(100);
	}
	assert.fail(message);
}
const alive = pid => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

for (const cancel of [false, true]) {
	test(`TUI: long relative wait ${cancel ? "cancels without killing" : "renders and completes"}`, {
		skip: !available || process.platform === "win32", timeout: 30_000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exec-tui-"));
		const name = `exec-wait-${process.pid}-${cancel ? "cancel" : "exit"}`;
		const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const pane = () => tmux("capture-pane", "-p", "-S", "-200", "-t", name);
		const events = () => readFileSync(join(root, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
		let pid;
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
				cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false },
			}));
			writeFileSync(join(root, "events.jsonl"), "");
			writeFileSync(join(root, "job.cjs"), `
require("node:fs").writeFileSync("job.pid", String(process.pid));
console.log("job-started");
setTimeout(() => console.log("job-finished"), ${cancel ? 30_000 : 5000});
`);
			const command = [
				"env", `HOME=${root}`, `PI_CODING_AGENT_DIR=${agentDir}`, "PI_OFFLINE=1",
				"PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS=", "EXEC_WAIT_SCENARIO=off",
				process.execPath, cli, "--no-session", "--no-extensions", "--no-skills",
				"--no-prompt-templates", "--no-themes", "-e", provider, "-e", extension,
				"--provider", "exec-wait-offline", "--model", "wait-model", "--thinking", "off", "run fixture",
			].map(quote).join(" ");
			tmux("new-session", "-d", "-s", name, "-x", "140", "-y", "42", "-c", root, command);
			await until(() => events().some(e => e.type === "wait-start"), "tool never attached");
			pid = Number(readFileSync(join(root, "job.pid"), "utf8"));
			await until(() => pane().includes("900.0s"), "long duration was not rendered");
			assert.ok(alive(pid));
			if (cancel) {
				tmux("send-keys", "-t", name, "Escape");
				await until(() => events().some(e => e.type === "wait-end"), "Esc did not detach");
				const end = events().find(e => e.type === "wait-end");
				assert.equal(end.details.wait_status, "cancelled");
				assert.equal(end.details.running, true);
				assert.ok(alive(pid), "Esc must leave the child alive");
			} else {
				await until(() => pane().includes("EXEC_WAIT_OK"), "completion not rendered");
				assert.match(pane(), /job-finished/);
				assert.equal(events().find(e => e.type === "wait-end").details.wait_status, "completed");
			}
			tmux("send-keys", "-t", name, "C-c");
			await pause(200);
			tmux("send-keys", "-t", name, "C-c");
			await until(() => !alive(pid), "session shutdown did not terminate the child");
		} finally {
			try { tmux("kill-session", "-t", name); } catch {}
			if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
			// If startup failed after spawning, clean up the fixture child too.
			if (!pid && existsSync(join(root, "job.pid"))) {
				try { process.kill(Number(readFileSync(join(root, "job.pid"), "utf8")), "SIGKILL"); } catch {}
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
}
