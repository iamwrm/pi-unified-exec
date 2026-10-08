/**
 * Actual Pi CLI (RPC mode) with a scripted local provider: a human steer sent
 * during a 900 s attached poll must end the wait early and reach the model on
 * the next turn, while the child keeps running. No live provider requests.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = process.env.PI_UNIFIED_EXEC_TEST_CLI ?? fileURLToPath(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/steer-provider.js", import.meta.url));

test("actual Pi: an RPC steer ends a long poll and reaches the next turn", { timeout: 40_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-exec-steer-"));
	const child = spawn(process.execPath, [
		cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-themes", "-e", provider, "-e", extension,
		"--provider", "exec-steer-offline", "--model", "steer-model", "--thinking", "off",
	], {
		cwd: root,
		env: {
			...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1",
			PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS: "",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	try {
		mkdirSync(join(root, "agent"));
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
			defaultProjectTrust: "always", compaction: { enabled: false }, cacheWarming: "off",
		}));
		writeFileSync(join(root, "job.cjs"), 'console.log("job-started"); setTimeout(() => {}, 30_000);\n');
		const send = (cmd: object) => child.stdin.write(`${JSON.stringify(cmd)}\n`);
		let steerSentAt = 0;
		let pollEnd: any;
		let pollEndedAt = 0;
		const assistantTexts: string[] = [];
		const done = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr.slice(-4000)}`)), 35_000);
			const rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				if (!line.startsWith("{")) return;
				const ev = JSON.parse(line);
				if (ev.type === "tool_execution_start" && ev.toolName === "write_stdin") {
					setTimeout(() => {
						steerSentAt = Date.now();
						send({ type: "steer", message: "STEER-TEST-4821" });
					}, 400);
				}
				if (ev.type === "tool_execution_end" && ev.toolName === "write_stdin") {
					pollEnd = ev;
					pollEndedAt = Date.now();
				}
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					for (const p of ev.message.content ?? []) if (p.type === "text") assistantTexts.push(p.text);
				}
				if (ev.type === "agent_end") {
					clearTimeout(timer);
					resolve();
				}
			});
			child.on("exit", (code) => reject(new Error(`pi exited early (${code}): ${stderr.slice(-4000)}`)));
		});
		send({ type: "prompt", message: "run fixture" });
		await done;

		assert.ok(pollEnd, "write_stdin never finished");
		assert.equal(pollEnd.isError, false, JSON.stringify(pollEnd));
		assert.equal(pollEnd.result.details.wait_status, "interrupted_by_steer");
		assert.equal(pollEnd.result.details.running, true, "the child must keep running");
		assert.ok(pollEndedAt - steerSentAt < 3000, `poll ended ${pollEndedAt - steerSentAt} ms after the steer`);
		assert.deepEqual(assistantTexts.filter((t) => /^STEER_/.test(t)), ["STEER_SEEN"]);
	} finally {
		child.kill("SIGTERM");
		rmSync(root, { recursive: true, force: true });
	}
});
