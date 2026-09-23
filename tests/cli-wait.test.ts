import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = process.env.PI_UNIFIED_EXEC_TEST_CLI ?? fileURLToPath(
	new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/wait-provider.js", import.meta.url));

for (const scenario of ["streaming", "idle", "off", "veto", "no-ttl", "cheap"]) {
	test(`actual Pi: uncapped relative wait with ${scenario} warming`, { timeout: 30_000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exec-wait-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
				cacheWarming: scenario === "idle" || scenario === "off" ? scenario : "streaming",
				defaultProjectTrust: "always",
				compaction: { enabled: false },
			}));
			writeFileSync(join(root, "events.jsonl"), "");
			writeFileSync(join(root, "job.cjs"), 'setTimeout(() => console.log("job-finished"), 3500);\n');
			const result = spawnSync(process.execPath, [
				cli, "--mode", "json", "--no-session", "--no-extensions", "--no-skills",
				"--no-prompt-templates", "--no-themes", "-e", provider, "-e", extension,
				"--provider", "exec-wait-offline", "--model", "wait-model", "--thinking", "off", "run fixture",
			], {
				cwd: root,
				env: {
					...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
					PI_CACHE_RETENTION: "short", PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS: "",
					EXEC_WAIT_SCENARIO: scenario,
				},
				encoding: "utf8", timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
			});
			assert.equal(result.error, undefined, result.stderr);
			assert.equal(result.status, 0, result.stderr);
			const rows = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
			const waits = rows.filter(row => row.type === "tool_execution_end" && row.toolName === "write_stdin");
			assert.equal(waits.length, 1, result.stdout.slice(-8000));
			assert.equal(waits[0].isError, false, JSON.stringify(waits[0]));
			assert.equal(waits[0].result.details.yield_time_ms, 900_000);
			assert.equal(waits[0].result.details.wait_status, "completed");
			assert.match(waits[0].result.details.output, /job-finished/);
			assert.match(result.stdout, /EXEC_WAIT_OK/);
			const events = readFileSync(join(root, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
			const warms = events.filter(e => e.type === "warm");
			if (scenario === "streaming" || scenario === "idle") {
				assert.ok(warms.length > 0, `No refresh: ${JSON.stringify(events)}`);
				assert.ok(warms.every(e => e.waitActive), "refresh must occur while the actual tool remains attached");
				assert.ok(events.some(e => e.type === "decision" && e.action === "warm" && !e.idle && e.waitActive));
			} else {
				assert.equal(warms.length, 0, JSON.stringify(events));
				if (scenario === "veto" || scenario === "cheap") assert.ok(events.some(e => e.type === "decision"));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
