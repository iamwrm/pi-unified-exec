# unified-exec

[![npm version](https://img.shields.io/npm/v/pi-unified-exec.svg?logo=npm&label=npm)](https://www.npmjs.com/package/pi-unified-exec)
[![npm downloads](https://img.shields.io/npm/dm/pi-unified-exec.svg)](https://www.npmjs.com/package/pi-unified-exec)
[![License](https://img.shields.io/npm/l/pi-unified-exec.svg)](./LICENSE)
[![CI](https://github.com/iamwrm/pi-unified-exec/actions/workflows/ci.yml/badge.svg)](https://github.com/iamwrm/pi-unified-exec/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/iamwrm/pi-unified-exec/actions/workflows/publish.yml/badge.svg)](https://github.com/iamwrm/pi-unified-exec/actions/workflows/publish.yml)

A pi extension that ports codex's `unified_exec` session model: every bash
command becomes a long-lived session the LLM drives with short polls, instead
of a single blocking call the agent waits on.

Mirrors codex's `exec_command` + `write_stdin` tool surface, with small
pi-flavor additions (`kill_session`, `list_sessions`).

## Highlights

- **Session-oriented, two-way I/O.** `exec_command` opens a long-lived
  session; the LLM keeps the `session_id` and drives the same process
  across turns by interleaving `write_stdin` writes and polls. Every
  byte the child prints is mirrored to an on-disk log file in parallel
  with the in-memory buffer, so the full history is recoverable via
  `read(log_path)` even after the LLM-visible tail truncates.
- **Bounded waits — the agent never stalls.** Every tool call returns
  within a hard ceiling: 30 s for `exec_command` and `write_stdin`,
  5 min for pure background polls. A long-running process keeps
  running; the agent just gets control back with a `session_id` and
  can poll again when it chooses.
- **Ctrl-C and other control bytes, not just stdin text.**
  `write_stdin` decodes C-style escapes (`\x03` Ctrl-C, `\x04` EOF,
  `\x1b[A` arrow-up, …) before writing, so the LLM can interrupt a
  stuck command or drive an interactive TUI — `chars_b64` covers the
  arbitrary-binary case.

## Why

Pi's built-in `bash` tool blocks until the process exits. For a dev server,
`tail -f`, a REPL, or anything interactive, the agent either has to set a huge
timeout and burn context waiting, or it times out and loses the process.

Codex's alternative: every call opens a session, yields after a bounded
`yield_time_ms` with output-so-far plus a `session_id`, and the LLM polls or
drives the session on later turns via `write_stdin(session_id, chars, …)`. A
PTY is available for interactive programs (Python REPL, ssh, sudo, TUIs).

This extension is a faithful port of that design, with codex's constants
preserved.

## Install

Published on npm as [`pi-unified-exec`](https://www.npmjs.com/package/pi-unified-exec).
Install via pi's package manager:

```bash
pi install npm:pi-unified-exec            # global (~/.pi/agent/settings.json)
pi install -l npm:pi-unified-exec         # project-local (.pi/settings.json)
```

`pi install` runs `npm install` under the hood, which fetches
`node-pty-prebuilt-multiarch` (prebuilt binaries — no compilation). If the
install fails on your platform, pipe mode (`tty: false`) still works, but PTY
mode (`tty: true`) will error with a clear message.

To try without installing:

```bash
pi -e npm:pi-unified-exec
```

Or clone this repo directly into pi's auto-discovery path:

```bash
git clone https://github.com/iamwrm/pi-unified-exec .pi/extensions/unified-exec
cd .pi/extensions/unified-exec && npm install
```

Reload a running pi with `/reload`.

## Tools

### `exec_command`

Runs a command in a persistent session.

| Param | Type | Default | Notes |
|---|---|---|---|
| `cmd` | string | — | Shell command. Required. |
| `workdir` | string | turn cwd | Working directory. |
| `shell` | string | `bash` | Shell binary. |
| `tty` | boolean | `false` | Allocate a PTY (requires node-pty). |
| `yield_time_ms` | number | `10_000` | How long to wait for output, clamped to [250, 30_000]. |

Response body (short output, no truncation):

```
[still running]                     (or [exited])
session_id: 1                       (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with session_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/pi-unified-exec-1-5cc5e104.log
cwd: /home/you/project
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
tty: false
---
<captured stdout+stderr>
```

When output exceeds the caps (50 KiB / 2000 lines), a footer is appended:

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-1-5cc5e104.log]
```

### `write_stdin`

Drives or polls an existing session.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `chars` | string | `""` | Empty = pure poll; non-empty writes (after escape decoding) then polls. Mutually exclusive with `chars_b64`. |
| `chars_b64` | string | `""` | Base64-encoded bytes to write. Binary-safe. Mutually exclusive with `chars`. |
| `yield_time_ms` | number | `250` | Clamped [250, 30_000]. Empty polls clamped [5_000, 300_000]. |

#### Control bytes and escapes in `chars`

`chars` is decoded as a C-style escape string before being written to stdin.
This lets the LLM send control bytes the wire format (antml/JSON tool_use)
strips of their meaning otherwise.

| Escape | Produces |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH` (2 hex) | single byte |
| `\\uHHHH` (4 hex) | Unicode char |
| `\\u{H…H}` (1–6 hex) | Unicode code point |
| `\\\\` `\\"` `\\'` | literal `\` `"` `'` |
| `\\X` not in the list above | preserved literally (both chars) |
| Raw bytes in the string | pass through untouched |

Examples:

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="password\n"    → "password" + LF
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
```

For arbitrary binary or when you want zero ambiguity, use `chars_b64`
instead:

```
write_stdin chars_b64="G3s6wgo="    → exact 5 decoded bytes
```

The two parameters are mutually exclusive — passing both rejects the call.
Malformed base64 also rejects.

### `kill_session`

Pi-flavor. Not in codex.

| Param | Type | Default | Notes |
|---|---|---|---|
| `session_id` | number | — | Required. |
| `signal` | string | `"SIGTERM"` | Escalates to SIGKILL after 2s. Pass `"SIGKILL"` to skip the grace. |

### `list_sessions`

Pi-flavor. Not in codex. Also prunes exited sessions from the in-memory store.

## Flag

By default, this extension **removes pi's built-in `bash` tool** from the
active set at session start so the LLM is steered toward `exec_command` /
`write_stdin`.

- `--keep-builtin-bash` — preserve the built-in `bash` alongside the
  unified-exec tools. Useful if you've got skills or prompts that explicitly
  expect `bash(cmd, timeout)`.

## TUI rendering

Custom `renderCall` and `renderResult` mirror pi's built-in `bash` tool
styling and add session-aware details:

**While streaming (live, updates every second):**
```
$ for i in {1..12}; do echo round $i; sleep 0.5; done (yield 2.5s · cwd: ~/project)
… 1 earlier lines
  round 2
  round 3
  round 4
  round 5

  elapsed 1.3s · session_id=2 · log: /tmp/pi-unified-exec-2-86b3f006.log
```

**After yield, session still alive:**
```
  yielded 2.5s · session_id=2 · log: /tmp/pi-unified-exec-2-86b3f006.log
```

**After process exits:**
```
  took 4.2s · exit_code=0 · log: /tmp/pi-unified-exec-1-5cc5e104.log
```

**write_stdin:**
```
⟳ poll → session_id=2 (yield 5.0s)               # empty chars
» print(7*6)\n → session_id=1 (yield 1.0s)         # with input
» ^C → session_id=1 (yield 1.0s)                  # control byte
```

By design this display omits some metadata the LLM sees (chunk_id,
original_token_count, full log path if tildified) — use `Ctrl+O` on the tool
row to expand the full captured output.

## Constants

Codex-parity unless noted:

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
MIN_EMPTY_YIELD_TIME_MS      = 5_000
MAX_BACKGROUND_POLL_MS       = 300_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
HEAD_TAIL_MAX_BYTES          = 1 MiB   (in-memory drain buffer)
MAX_SESSIONS                 = 64
WARNING_SESSIONS             = 60
LRU_PROTECTED_COUNT          = 8

# Diverges from codex — matches pi's built-in bash instead:
DEFAULT_MAX_BYTES            = 50 KiB  (LLM-visible per-call truncation cap)
DEFAULT_MAX_LINES            = 2000
OUTPUT_POLL_INTERVAL_MS      = 250     (pi-specific: onUpdate cadence)
PREVIEW_LINES                = 5       (TUI preview lines before ctrl+o expand)
```

## Semantic notes

- **Early exit**: commands that finish in <150 ms never touch the session
  store. The response has `exit_code`, no `session_id`.
- **Session persistence between calls**: if a process exits after a tool call
  returns but before the next one, the session stays in the store. The next
  `write_stdin(session_id, …)` call will observe the exit and return
  `exit_code`, then remove the session. (Matches codex's
  `refresh_process_state` pattern.)
- **External abort (Esc)**: breaks the current call's wait but does not kill
  the session. The next turn can still drive it.
- **Session shutdown**: all live sessions are terminated. Codex behavior.
  (Use the separate `bash-background` extension if you need true disown.)
- **LRU eviction**: at `MAX_SESSIONS`, the oldest non-protected session is
  evicted. The 8 most-recently-used are never pruned. Exited sessions are
  preferred as victims.
- **Head+tail output buffer**: per session, up to 1 MiB retained, split 50/50
  between the beginning and end of the output stream. A separate 32 KiB
  rolling tail window feeds streaming `onUpdate` events during waits.

## Architecture

```
src/
├── index.ts              # tool registration, event handlers, flag
├── session.ts            # ExecSession: spawn, read, write, kill, log-stream, state
├── session-store.ts      # SessionStore + LRU eviction (matches codex)
├── head-tail-buffer.ts   # direct port of codex's HeadTailBuffer
├── collect.ts            # collectOutputUntilDeadline
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # node-pty loader + pipes fallback
├── render.ts             # renderCall / renderResult for the TUI
└── unescape.ts           # C-style escape decoder for write_stdin `chars`
```

## Worked examples

### 1. Dev server (never exits on its own)

```
> exec_command(cmd="npm run dev", yield_time_ms=5000)
[still running]
session_id: 1
---
> Server listening on :3000

> exec_command(cmd="curl -s localhost:3000/health", yield_time_ms=2000)
[exited]
exit_code: 0
---
{"ok": true}

> write_stdin(session_id=1, chars="", yield_time_ms=10000)      # poll dev server
[still running]
---
  GET /health 200 in 3ms

> kill_session(session_id=1)                                    # stop it
Killed session 1 (pid 12345) with SIGTERM — exit_code=143
```

### 2. Interactive Python REPL

```
> exec_command(cmd="python3 -q", tty=true, yield_time_ms=1500)
[still running]
session_id: 1
---
>>>

> write_stdin(session_id=1, chars="print(7*6)\n", yield_time_ms=1000)
[still running]
---
42
>>>

> write_stdin(session_id=1, chars="exit()\n", yield_time_ms=1000)
[exited]
exit_code: 0
```

### 3. `sudo` (interactive password)

```
> exec_command(cmd="sudo -k && sudo whoami", tty=true, yield_time_ms=1500)
[still running]
session_id: 1
---
[sudo] password for wr:

> write_stdin(session_id=1, chars="<password>\n", yield_time_ms=2000)
[exited]
exit_code: 0
---
root
```

## Tests

From the repo root:

```bash
npm install
npx tsx --test tests/*.test.ts
```

102 tests across 9 files: HeadTailBuffer (direct port of codex's unit
tests), Notify/Gate/sleep, collectOutputUntilDeadline (9 scenarios),
SessionStore LRU (10 scenarios), truncateTail (ported from pi, 13
scenarios), unescapeChars (14 scenarios for `\xHH`/`\uHHHH`/`\u{…}`/unknown
escapes/Windows path footguns), chars-encoding end-to-end (13 scenarios
covering raw bytes, escape decoding, chars_b64 binary-safety, and
mutual-exclusion errors), full e2e pipes (17 scenarios incl. log-file
retention + byte/line truncation + cwd/command fields), PTY mode (3
scenarios: simple command, Python REPL drive, Ctrl-C injection).

## Improvements over codex

This port preserves codex's session semantics but borrows two pieces from pi's
built-in `bash` tool that codex itself treats as unsolved:

**1. Full output retained on disk, not just head+tail in memory.**
Codex caps each session's in-memory buffer at 1 MiB and silently drops middle
bytes once it fills. We mirror every byte the child writes to
`/tmp/pi-unified-exec-<sid>-<random>.log` in parallel with the in-memory
buffer. The file has the complete, unaltered stream across the entire
session's lifetime; nothing is lost.

**2. LLM-visible output is tail-capped at pi's `bash` defaults (50 KiB or
2000 lines, whichever hits first), with a pointer to the log file.**
Codex serializes up to ~40 KiB to the LLM on every call (10 000 tokens of
middle-truncated text). That's a bounded-but-generous context cost per call,
and codex gives the LLM no way to recover the dropped middle. Our port
tail-truncates per pi's `bash` tool and exposes `log_path` in the response
header and tool-call details. When the LLM wants the full output it can
`read(log_path)` with pi's file-read tool.

As a consequence we dropped codex's `max_output_tokens` parameter on both
`exec_command` and `write_stdin`. The per-call cap is fixed; if the LLM
wants a tighter snippet it can ask for a specific slice by reading from the
log file.

| | codex | this port |
|---|---|---|
| Session in-memory retention | 1 MiB head+tail (lossy) | 1 MiB head+tail (lossy) — same |
| **Session full retention** | **none** | **full log file on disk** |
| LLM-visible per call | ≤40 KiB, middle-truncated | ≤50 KiB / ≤2000 lines, tail-truncated |
| LLM-visible truncation recovery | none | `read(log_path)` for the full stream |
| Per-call `max_output_tokens` knob | yes (default 10 000) | removed; fixed 50 KiB/2000 lines |
| Truncation marker in body | `…N tokens truncated…` | `[Showing lines X-Y of T. Full output: …]` |

The `log_path` field is exposed in every `exec_command` and `write_stdin`
response (as a header line and in tool-call details), plus in `list_sessions`
per-entry and in `kill_session` details.

Log files live in `/tmp/` and are never auto-deleted (they're just regular
files; `/tmp` cleanup is the OS's problem). If you run the same session to
completion and never revisit the log, it'll linger until your next reboot.

## Other pi-flavor additions

- `kill_session` and `list_sessions` tools (codex has neither).
- `write_stdin` also works in pipe mode (`tty: false`), not just PTY.
  Useful for feeding lines to `jq`, `sort`, etc.
- Streaming `onUpdate` tail window for TUI rendering during yields.
- Rich `renderCall` / `renderResult` mirroring pi bash's styling: command
  banner with `(yield Ns · cwd: …)` suffix, 5-line collapsed preview with
  `ctrl+o` expand, live "elapsed" counter, `yielded`/`took`/`exit_code`
  status footer, and a `⟳ poll` / `» input` banner for `write_stdin`.
- `cwd`, `command`, and `yield_time_ms` are surfaced in tool-call details
  (and `cwd` in the LLM-visible response header) for easy debugging.

## What's not here (vs codex)

- No sandbox / approval / permission stack (pi doesn't have one).
- No network-proxy integration.
- No persistence across pi restarts. (Processes are terminated on
  `session_shutdown`.)
- No PTY resize (SIGWINCH) handling.
- No Windows PTY (conpty). Prebuilt binaries cover linux/macOS only.

## Source map vs codex

| unified-exec (TS) | codex (Rust) |
|---|---|
| `src/head-tail-buffer.ts` | `codex-rs/core/src/unified_exec/head_tail_buffer.rs` |
| `src/collect.ts` | `codex-rs/core/src/unified_exec/process_manager.rs::collect_output_until_deadline` |
| `src/notify.ts` (Notify/Gate) | tokio `Notify` + `watch::Sender<bool>` |
| `src/session.ts` | `codex-rs/core/src/unified_exec/process.rs::UnifiedExecProcess` |
| `src/session-store.ts` | `codex-rs/core/src/unified_exec/process_manager.rs::ProcessStore` |
| `src/pty.ts` | `codex-rs/utils/pty` (pty.rs + pipe.rs) |
| `truncateTail` from `@mariozechner/pi-coding-agent` | (no equivalent in codex) — pi bash's tail truncator |
| `src/unescape.ts` | (no equivalent in codex) — C-style escape decoder for `chars` |
| `src/render.ts` | (no equivalent in codex) — pi TUI renderCall / renderResult |
| `src/index.ts` exec_command handler | `codex-rs/core/src/tools/handlers/unified_exec.rs` |

---

## Contributing / hacking

See [docs/DEV.md](docs/DEV.md) for the full maintainer guide:
onboarding, repo layout, dev loop, test recipes, release workflow
(npm publish via GitHub Actions Trusted Publisher), debugging aids,
and the codex-side sources to consult before changing core behavior.
