import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPACT_CODEMODE_ENV } from "../src/codemode-render.ts";

const cli = process.env.PI_UNIFIED_EXEC_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/codemode-provider.js", import.meta.url));
const mcpFixture = fileURLToPath(new URL("./fixtures/codemode-mcp.mjs", import.meta.url));
type RunOptions = { fixed?: boolean; pattern?: string; mode?: "on" | "only"; budget?: number; active?: boolean; mcp?: boolean; packageEnabled?: boolean; exclude?: boolean };
// `fixed` is the default; `exclude` is the 0.12.1-era `-builtin:codemode` setup.
function run({ fixed = true, pattern = "parity", mode = "on", budget = 3000, active = true, mcp = false, packageEnabled = true, exclude = false }: RunOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-exec-codemode-"));
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			cacheWarming: "off", defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false,
			...(active ? { defaultTools: ["+codemode"] } : {}), codemode: { mode, inlineBudget: budget },
			extensions: exclude ? ["-builtin:codemode"] : [],
		}));
		const capture = join(root, "requests.jsonl");
		const child = spawnSync(process.execPath, [
			cli, "--mode", "json", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"-e", provider, ...(packageEnabled ? ["-e", extension, "--keep-builtin-bash"] : []),
			"--provider", "exec-codemode-offline", "--model", "codemode-model", "--thinking", "off", "run fixture",
		], {
			cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
				[COMPACT_CODEMODE_ENV]: fixed ? undefined : "0", EXEC_CODEMODE_PATTERN: pattern, EXEC_CODEMODE_CAPTURE: capture,
				EXEC_CODEMODE_MCP: mcp ? mcpFixture : "",
			}, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0, child.stderr);
		const events = child.stdout.trim().split("\n").map(line => JSON.parse(line));
		const requests = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const ends = events.filter(e => e.type === "tool_execution_end" && e.toolName === "codemode");
		for (const end of ends) assert.equal(end.isError, false, JSON.stringify(end.result));
		assert.match(child.stdout, /EXEC_CODEMODE_OK/);
		return { events, requests, ends, stderr: child.stderr };
	} finally { rmSync(root, { recursive: true, force: true }); }
}
const normalizedContent = (ends: any[]) => ends.map(e => e.result.content.map((c: any) => c.type === "text" ? { ...c, text: c.text.replace(/Wall time [\d.]+ seconds/, "Wall time <elapsed> seconds") } : c));
const stores = (events: any[]) => events.filter(e => e.type === "entry_appended" && e.entry.customType === "codemode-store").map(e => e.entry.data);
const declarations = (requests: any[]) => requests.map(r => r.tools);

for (const mode of ["on", "only"] as const) for (const budget of [0, 3000]) {
	test(`codemode CLI native parity: ${mode}, budget ${budget}`, { timeout: 30_000 }, () => {
		const native = run({ fixed: false, mode, budget });
		const fixed = run({ mode, budget });
		const excluded = run({ mode, budget, exclude: true });
		assert.deepEqual(normalizedContent(excluded.ends), normalizedContent(native.ends));
		// Legacy exclusion: Pi dropped `+codemode` at startup, so the late
		// activation appends it; declarations match apart from their order.
		const byName = (requests: any[]) => declarations(requests).map((tools: any[]) => [...tools].sort((a, b) => a.name.localeCompare(b.name)));
		assert.deepEqual(byName(excluded.requests), byName(native.requests));
		assert.doesNotMatch(excluded.stderr, /was not loaded|registers tool|conflict/i);
		assert.deepEqual(normalizedContent(fixed.ends), normalizedContent(native.ends));
		assert.deepEqual(declarations(fixed.requests), declarations(native.requests));
		assert.equal(fixed.ends.length, 3);
		assert.deepEqual(stores(fixed.events), stores(native.events));
		assert.equal(stores(fixed.events).length, 3);
		assert.equal(stores(fixed.events)[0].set.probe.exit_code, 0);
		assert.deepEqual(stores(fixed.events)[2].delete, ["remove"]);
		const names = fixed.requests[0].tools.map((t: any) => t.name);
		assert.ok(names.includes("codemode"), "+codemode must activate the replacement");
		assert.equal(names.includes("read"), mode === "on");
		assert.doesNotMatch(fixed.stderr, /was not loaded|registers tool|conflict/i);
		const description = fixed.requests[0].tools.find((t: any) => t.name === "codemode").description;
		if (budget === 0) assert.doesNotMatch(description, /declare const tools:/);
		else assert.match(description, /declare const tools:/);
	});
}

test("codemode CLI replacement remains inactive without normal activation", () => {
	const fixed = run({ active: false, pattern: "inactive" });
	const native = run({ fixed: false, active: false, pattern: "inactive" });
	assert.deepEqual(declarations(fixed.requests), declarations(native.requests));
	assert.ok(!fixed.requests[0].tools.some((t: any) => t.name === "codemode"));
});

test("codemode CLI explicit opt-out leaves the built-in behavior intact", () => {
	const optOut = run({ fixed: false });
	const builtIn = run({ fixed: false, packageEnabled: false });
	assert.deepEqual(normalizedContent(optOut.ends), normalizedContent(builtIn.ends));
	assert.deepEqual(stores(optOut.events), stores(builtIn.events));
	assert.doesNotMatch(optOut.stderr, /was not loaded|registers tool|conflict/i);
});

test("codemode CLI MCP auto-activates the schema-identical replacement", () => {
	const fixed = run({ active: false, mcp: true, pattern: "mcp" });
	const native = run({ fixed: false, active: false, mcp: true, pattern: "mcp" });
	assert.deepEqual(normalizedContent(fixed.ends), normalizedContent(native.ends));
	assert.deepEqual(declarations(fixed.requests), declarations(native.requests));
	assert.ok(fixed.requests[0].tools.some((t: any) => t.name === "codemode"));
	assert.match(fixed.ends[0].result.content.map((c: any) => c.text ?? "").join("\n"), /MCP_OK/);
	assert.doesNotMatch(fixed.stderr, /not reachable|was not loaded|conflict/i);
});

test("codemode CLI preserves native output truncation and full-output file", () => {
	const end = run({ pattern: "spill" }).ends[0];
	const path = end.result.details.fullOutputPath;
	assert.ok(path);
	try {
		assert.match(end.result.content.map((c: any) => c.text ?? "").join("\n"), /Warning: truncated output/);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).output.trim().split("\n").length, 40);
	} finally { rmSync(path, { force: true }); }
});
