# Changelog

All notable changes to this project. **Newest entries go on top.**

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
