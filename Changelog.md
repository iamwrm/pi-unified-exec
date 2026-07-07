# Changelog

All notable changes to this project. **Newest entries go on top.**

## 2026-07-07 — 0.5.0

### Changed

- **Migrated to the `@earendil-works/*` package scope**: upstream pi renamed
  `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` to
  `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` in 0.74.0 (the
  old npm scope is frozen at 0.73.1; the repo moved to `earendil-works/pi`).
  All imports in `src/` and `tests/`, both peerDependencies, and both dev pins
  now use the new scope. Pi's extension loader still aliases the old scope at
  runtime, but that compat shim is slated for removal upstream. Bumped the
  package version to 0.5.0 because the peer dependency names changed.
- **Dev pins bumped 0.73.0 → 0.80.3** (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`).
- Updated `README.md`, `docs/DEV.md`, and `AGENTS.md` references (package
  scope, changelog/clone URLs → `earendil-works/pi`).

### Verified

- **Upstream compatibility with `@earendil-works/pi-coding-agent` 0.80.3**:
  audited every release note from 0.73.0 to 0.80.3. Our entire import surface
  (`ExtensionAPI`, `ExtensionContext`, `AgentToolResult`,
  `ToolRenderResultOptions`, `Theme`, `TruncationResult`, `formatSize`,
  `truncateTail`, `truncateToVisualLines`, `DEFAULT_MAX_BYTES`,
  `DEFAULT_MAX_LINES`; pi-tui `Container`, `Text`, `truncateToWidth`,
  `Component`) is unchanged. The only breaking changes upstream were the
  minimum Node bump to 22.19.0 (0.75.0, dev-only impact) and the pi-ai root
  API move to `/compat` (0.80.0, we don't import pi-ai). `npx tsc --noEmit`
  clean; all 129 tests pass.

### Fixed

- **Test pins updated for new `truncateTail` line-counting semantics**:
  since pi ≥ 0.80, a trailing `\n` no longer counts a phantom empty last line
  and empty input counts 0 lines (previously `"".split("\n") → [""]` counted
  1). Updated `tests/truncate.test.ts` and the `totalLines` expectations in
  `tests/e2e.test.ts` (4001→4000, 2501→2500). No production-code change was
  needed — the `[Showing lines X-Y of Z]` marker in `src/index.ts` derives
  from the same counts and is now more accurate.

## 2026-06-10 — 0.4.0

### Fixed

- **Log-stream error no longer orphans live sessions**: a log-mirroring error
  (disk full, permissions, …) used to mark the session as exited while the
  child kept running, making it unkillable (`kill()` no-ops once exited) and
  letting `list_sessions` drop it without terminating the process. Failures
  are now recorded on the session without flipping its exited state.
- **Async spawn errors are diagnosable**: pipe-mode spawn failures delivered
  via the child's async `error` event (ENOENT shell binary, nonexistent
  `workdir`) previously produced an empty `[exited]` response with no
  exit_code, signal, failure, or output. The error message (plus a
  shell/workdir hint for ENOENT) is now surfaced as `failure_message`.
- **EPIPE no longer crashes the host**: `child.stdin` had no `error` handler,
  so writing to a child that closed its stdin raised an unhandled stream
  `error` event and crashed the whole pi process. Errors are now swallowed,
  and `write_stdin` reports `failure_message: "stdin write failed: …"` when
  bytes cannot be delivered to a live session (stdin destroyed/ended).
  `write()` also no longer conflates stream backpressure with delivery
  failure.
- **collectOutputUntilDeadline listener/timer leak**: each loop iteration
  registered fresh `abort` listeners on the exit/external signals and started
  a fresh deadline timer without ever cleaning them up — chatty processes
  tripped Node's EventTarget max-listener warning after ~10 chunks, and a
  30-minute empty poll could accumulate thousands of live timers. The
  deadline/abort promises are now created once per call and all
  listeners/timers are released when the call returns. The no-external-abort
  placeholder promise is also scoped per call (not module-global) so race
  reactions attached to it stay garbage-collectable.
- **PTY signal mapping covers the full platform table**: the numeric→name
  signal map was a hand-picked 6-entry table, so tty-mode children killed by
  SIGSEGV/SIGPIPE/SIGUSR1/… were reported as `exit_code=0`. The map is now
  built from `os.constants.signals` (exported as `signalNameFromNumber`).
- **`write_stdin` rendering of `chars_b64`**: calls carrying only a base64
  payload rendered as `⟳ poll`; they now render as `» (base64, N bytes)`.
- **`kill_session` signal validation**: signal names are normalized (`term`,
  `INT`, `sigkill` all work) and unknown names are rejected with an error
  instead of silently no-opping and then escalating to SIGKILL anyway.

### Changed

- **`list_sessions` reports exited sessions once before pruning**: instead of
  silently dropping sessions that exited between tool calls, the listing now
  includes them one final time with `running: false`, `exit_code`/`signal`,
  `failure_message`, and `log_path` (`active_count` still counts only live
  sessions), preserving the "exit information is never silently lost"
  guarantee.
- **Shutdown escalates to SIGKILL**: `session_shutdown` now waits up to 1s for
  SIGTERM'd children to exit and SIGKILLs survivors (children run in detached
  process groups and would otherwise outlive pi when they trap SIGTERM).
- **Removed dead `HEAD_TAIL_MAX_BYTES` constant** in `src/index.ts` (the
  per-session buffer cap lives in `src/session.ts`).

### Added

- **`/unified-exec-sessions` command**: human-facing escape hatch that lists
  live sessions in a selector and kills the chosen one (or all) without going
  through the model, sharing the kill/escalate/drain logic with
  `kill_session`.
- **Streaming parity test**: the e2e harness now captures `onUpdate` and
  asserts multiple growing partial outputs during a long-running
  `exec_command`, plus 14 more regression tests covering every fix above
  (129 tests total across 10 files).

## 2026-06-02 — 0.3.6

### Changed

- **Configurable empty-poll cap**: restored the default pure `write_stdin`
  empty-poll `yield_time_ms` cap to 30 minutes and added
  `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` so cache-sensitive environments can lower
  the cap (for example to 300 seconds / 5 minutes).

## 2026-06-02 — 0.3.5

### Changed

- **Empty-poll cache safety**: reverted pure `write_stdin` poll
  `yield_time_ms` clamping from 30 minutes back to 5 minutes (300 seconds) and
  updated model guidance/docs so long polls stay within typical prompt-cache
  expiry windows. Superseded by 0.3.6's configurable cap.

## 2026-06-01 — 0.3.4

### Fixed

- **macOS short-command output race**: pipe-mode sessions now wait for the
  child-process `close` event instead of `exit` before finalizing, preserving
  trailing stdout/stderr from very short-lived commands in CI.

## 2026-06-01 — 0.3.3

### Changed

- **Long-running job polling guidance**: updated the `write_stdin` tool prompt
  and README to tell models to use a single long empty poll for known
  non-interactive jobs instead of repeated short polls, reducing context noise.

## 2026-05-27 — 0.3.2

### Changed

- **Longer empty-poll yield cap**: raised empty `write_stdin` poll
  `yield_time_ms` clamping from 300 seconds to 30 minutes, allowing agents to
  wait longer on known-running background sessions without repeated polls.
  Superseded by the 2026-06-02 cache-safety revert.

## 2026-05-06

### Changed

- **Compatibility follow-ups resolved**: replaced the hand-restated render
  context shape with a type derived from pi's exported `ToolDefinition`, and
  documented the resolved follow-ups in `to_improve.md`.
- **Improvement backlog detail**: expanded each `to_improve.md` item with a
  lightweight plan, code references, risk evaluation, and verification gate
  based on the latest pi release notes.
- **Upstream pi 0.73.0 compatibility**: cloned and audited the latest
  `badlogic/pi-mono` source at `30298368` and updated development dependencies
  to `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` 0.73.0. Switched
  tool schema imports and package metadata from the legacy
  `@sinclair/typebox` package name to pi's current `typebox` package while
  keeping the existing extension API usage intact.

### Added

- **Shutdown metadata coverage**: added tests for all current pi
  `session_shutdown` reasons so session cleanup remains covered across quit,
  reload, and session replacement paths.
- **Upstream improvement notes**: added `to_improve.md` with follow-up
  opportunities and pitfalls found while reviewing recent pi releases.

## 2026-04-27 — 0.3.1

### Fixed

- **macOS CI short-command drain race**: increased the bounded trailing-output
  drain window for very fast commands so stdout/stderr that arrives shortly
  after the process exit event is captured reliably on macOS Node 22.

## 2026-04-27 — 0.3.0

### Added

- **Running-session UI after `/tree`**: while unified-exec processes are still
  alive, the extension now keeps a TUI footer status. After `/tree` navigation
  it also shows a widget listing live session IDs and commands so humans can
  see that processes survived branch navigation. The footer/widget now refresh
  immediately when a background session exits, without waiting for the next
  tool call or turn.
- **Contributor guidance**: added `AGENTS.md` guidance requiring changelog
  updates alongside future code, docs, tests, or package metadata edits.

## 2026-04-27 — 0.2.2

### Changed

- **Prompt guideline safety**: changed the `exec_command` file-exploration hint
  to only prefer `grep`/`find`/`ls` when those dedicated tools are actually
  available, and to suggest shell fallbacks via `rg`, `fd` when installed,
  `find`, and `ls` otherwise.

## 2026-04-21

### Verified

- **Upstream compatibility with `@mariozechner/pi-coding-agent` 0.68.0**:
  audited the upstream 0.68.0 `CHANGELOG.md` against our extension's
  usage of pi-coding-agent. All 0.68.0 breaking changes
  (`createAgentSession({ tools })` now takes `string[]` instead of
  `Tool[]`; removal of prebuilt cwd-bound tool exports such as
  `readTool`, `bashTool`, `editTool`, `writeTool`, `grepTool`,
  `findTool`, `lsTool`, `readOnlyTools`, `codingTools`, and the
  corresponding `*ToolDefinition` values; removal of ambient
  `process.cwd()` fallbacks from `DefaultResourceLoader`,
  `loadProjectContextFiles()`, and `loadSkills()`) target APIs we do
  **not** call. The types, helpers, constants, and `ExtensionAPI`
  surface we import (`ExtensionAPI`, `ExtensionContext`,
  `AgentToolResult`, `ToolRenderResultOptions`, `Theme`,
  `TruncationResult`, `formatSize`, `truncateTail`,
  `truncateToVisualLines`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`,
  `pi.on`, `pi.registerFlag`, `pi.getFlag`, `pi.registerTool`,
  `pi.getActiveTools`, `pi.setActiveTools`) are unchanged. The new
  additive fields on `SessionShutdownEvent` (`reason`,
  `targetSessionFile`) do not affect our handler. No extension code
  changes required; the devDep pin can be bumped at leisure. See
  [docs/DEV.md#checking-upstream-compatibility](docs/DEV.md#checking-upstream-compatibility)
  for the recipe used.

## 2026-04-20

### Changed

- **Prompt optimization**: LLM-visible tool prompts trimmed by ~56% (~384
  tokens saved per request). Tightened `description` strings, removed
  redundant `promptGuidelines`, and shortened parameter descriptions for
  `exec_command`, `write_stdin`, `kill_session`, and `list_sessions`. The
  `chars` escape table, `yield_time_ms` bounds, and `session_id` vs
  `exit_code` semantics are each now documented in a single canonical
  location instead of 3–4.
- **`exec_command` guidelines**: added a rephrased file-exploration hint —
  *"Prefer grep/find/ls tools over exec_command for file exploration
  (faster, respects .gitignore)."* This replaces the auto-added `bash`-
  targeted guideline that pi's `system-prompt.ts` stops emitting once the
  built-in `bash` tool is filtered out (the default under this extension).

### Fixed

- **Renderer parity with pi's built-in `bash`**: removed the
  `commandPreview` whitespace collapsing from `renderExecCommandCall` in
  `src/render.ts`. Multi-line commands (heredocs, multi-line `node -e` /
  `python3 -c`) now render verbatim in the `$ …` banner across multiple
  rows, matching
  `pi-mono/packages/coding-agent/src/core/tools/bash.ts:formatBashCall`.
