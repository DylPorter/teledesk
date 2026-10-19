# teledesk mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the model-mediated outbound path (the `reply` tool) with a pure-code Telegram mirror of the session chat — prompts, collapsed tool-progress batches, final answers, and a capped context snapshot at `/desk` activation — driven by Claude Code hooks, invisible to the agent.

**Architecture:** A per-spawn token (`TELEDESK_MIRROR`) from the launcher flows through the process env to both the channel server's `hello` and every hook invocation. Hooks pipe their JSON to a stateless `teledesk mirror-hook` CLI that writes one line to the daemon's desk socket and exits 0. The daemon binds token→session, dedupes phone-origin echoes, runs an order-tolerant batch state machine for tool progress (send-then-edit per collapsed run), and posts chat with distinct marks. Chat events (prompt/answer/turn boundary/snapshot) run foreground and ordered; tool events run backgrounded and tolerate reordering.

**Tech Stack:** TypeScript (Node 22, ESM), zod, vitest, node:net unix sockets, node:sqlite, Telegram Bot API (existing `BotApi`), Claude Code hooks (UserPromptSubmit / PreToolUse / PostToolUse / Stop).

**Spec:** `docs/superpowers/specs/2026-10-18-teledesk-mirror-design.md` — read it first; it carries the rationale and the decided behaviour. The builder-check resolutions (foreground/background split, order tolerance, `cc_session` binding, capped snapshot) are folded into it.

## Global Constraints

- Every hook-triggered code path exits 0 and cannot block a session longer than `MIRROR_TIMEOUT_MS = 1500` ms. A dead daemon means silence, never an error surface.
- All mirror text is bounded by the existing `MAX_TEXT_BYTES` (64 KB) / `MAX_LINE_BYTES` (256 KB); the CLI clips before sending, the daemon's zod decode re-checks.
- No new runtime dependencies. `node:crypto` for the token; everything else exists.
- Public repo: no vault paths, no personal names, no Telegram ids in code, tests, fixtures, or docs.
- Commit style follows the repo: sentence-style subjects, no conventional-commit prefixes, no attribution lines (e.g. `Shim: classify argv in shell from the launcher's own lists…`).
- `MIN_CLAUDE = "2.1.234"` floor and the `TELEDESK=1` env guard semantics are unchanged; the desk still requires launcher-spawn + explicit `/desk` + solo-group privacy check.
- Naming: the Claude Code session UUID field is **`cc_session`** everywhere (protocol, CLI, router). The daemon's existing numeric `session_id` (welcome message, row ids) is untouched — never overload the two.
- Tests live in `tests/`; shared harness moves to `tests/helpers.ts` (Task 2); new mirror tests go in `tests/mirror.test.ts`. Run with `npm test` (vitest).
- Task 10 is the only task that deletes `reply`; until then every commit keeps the suite green with `reply` still present.

## Review Focus

Input classes the spec implies that a happy-path test would miss — each is pinned to the task that owns it:

1. **Tool-only turn** (assistant message with no text blocks, e.g. a turn that ends in a question rendered as tool work): Stop must still send `turn_end` and must NOT send an empty `assistant` line. → Task 6 test `extractTurnAssistant returns undefined for a tool-only turn`.
2. **Hook JSON drift** (missing fields, unknown event names, malformed JSON — a CC upgrade changed the shape): CLI exits 0, sends nothing, never throws. → Task 5 tests `malformed stdin exits 0` and `unknown event exits 0 without connecting`.
3. **Nested `claude -p`** inheriting `TELEDESK_MIRROR` with its own `cc_session`: daemon drops every mismatched line after the first binding. → Task 7 test `mirror lines with a foreign cc_session are dropped`.
4. **Oversized assistant text** (> 64 KB single turn): CLI clips to `MAX_TEXT_BYTES` before send; the line still decodes; daemon chunks it. → Task 6 test `extractTurnAssistant output is clipped to MAX_TEXT_BYTES`.
5. **Edit failure mid-batch** (Telegram 429 exhaustion, message deleted, 48h window): the pending result posts as a new message and the batch re-points at it — no lost outcome, no resurrected bubble. → Task 8 test `edit failure falls back to a new message and repoints the batch`.

---

### Task 1: Spike — pin the Claude Code hook facts

No product code. The protocol's `cc_session` binding rule and the installer's detach mechanism depend on facts only a real CC run can answer. Everything else in this plan assumes the defaults below; if the spike contradicts one, apply the listed fallback and note it in the record.

**Files:**
- Create: `docs/superpowers/spikes/2026-10-18-hook-facts.md` (the committed decision record)
- Scratch (never committed): `/tmp/hook-spike/`

**Interfaces:**
- Produces: the decision record; later tasks cite it. No code interfaces.

Defaults the plan assumes, and the fallback if wrong:

| # | Question | Default assumption | Fallback if false |
|---|---|---|---|
| a | Hook JSON shapes: `UserPromptSubmit` → `prompt`, `transcript_path`, `session_id`; `PreToolUse`/`PostToolUse` → `tool_name`, `tool_input`/(Post:) `tool_response`, `transcript_path`, `session_id`; `Stop` → `transcript_path`, `session_id` | as listed | adapt `HookInput` + extraction in Task 5/6 to the logged reality |
| b | Do PreToolUse/PostToolUse fire for **Task-subagent** tool calls, and with which `session_id`? | fire, parent's session_id | don't fire → subagent coverage needs `SubagentStop` (add to Task 9 hooks, record it); different session_id → Task 7 binding flips to accept-and-mark (bubbles prefixed `⤷ nested `) |
| c | Does a backgrounded hook child (`cmd </dev/stdin >/dev/null 2>&1 & exit 0`) survive the hook's own exit and run to completion? | survives | CLI self-detaches instead: re-spawn `process.execPath` with subcommand `mirror-send` and the payload in env, `detached: true`, `.unref()`, parent exits 0 |
| d | Does PostToolUse fire for MCP tools, matcher `mcp__teledesk__desk_on`? | fires | the capped snapshot can't ride the hook: ship history kind dormant (protocol stays, no trigger) and record that `/desk` is forward-only until CC supports it — do NOT move extraction daemon-side (no transcript access there) |
| e | Does UserPromptSubmit fire for channel-injected (phone) messages? | fires, wrapped in `<channel …>` | doesn't fire → Task 7 dedupe stays (harmless no-op) |
| f | Does CC wait on PreToolUse hook exit before running the tool? | waits | unchanged (backgrounding already assumes it) |

- [ ] **Step 1: Build the logging rig**

`/tmp/hook-spike/.claude/settings.json` with all four events (matcher `*` for tool events), each command `cat >> /tmp/hook-spike/log.jsonl` (plus, for (c), one PreToolUse entry `(sleep 30; echo survived >> /tmp/hook-spike/log.jsonl) </dev/null >/dev/null 2>&1 & exit 0`).

- [ ] **Step 2: Run the probes**

In `/tmp/hook-spike`: `claude -p 'Run bash echo one, then read a file, then answer'` for shapes/ordering; `claude -p 'Use the Task tool to spawn a general-purpose agent that runs bash echo sub'` for (b); compare `session_id` values across parent/subagent entries; after the run, `grep survived /tmp/hook-spike/log.jsonl` for (c). For (d)+(e): a real desk session (`teledesk code`, `/desk`, one phone message) with the same logging hooks merged into user settings — coordinate with Dylan for the phone step; if unavailable, mark (d)/(e) unverified and keep defaults.

- [ ] **Step 3: Write and commit the decision record**

`docs/superpowers/spikes/2026-10-18-hook-facts.md`: one section per question (a–f) — observed JSON excerpts (redact paths/ids), verdict, and which fallback (if any) later tasks must apply. Commit: `Spike: the hook facts the mirror protocol depends on, with fallbacks`.

---

### Task 2: Test helpers + the mirror protocol line

**Files:**
- Create: `tests/helpers.ts`
- Modify: `src/desk/protocol.ts` (ChannelMessage union, hello variant)
- Modify: `tests/desk.test.ts` (import helpers instead of defining them)
- Test: `tests/mirror.test.ts` (new)

**Interfaces:**
- Produces (used by Tasks 4–8):
  - `export const MIRROR_TOKEN = /^[0-9a-f]{32}$/;`
  - `export const MirrorLine` — zod discriminated union on `kind`:
    `{ kind: "user_prompt", text }` · `{ kind: "assistant", text }` · `{ kind: "tool_start", tool_name: ≤256, summary: ≤2048 bytes }` · `{ kind: "tool_end", tool_name: ≤256, ok: boolean, summary: ≤2048 bytes }` · `{ kind: "turn_end" }` · `{ kind: "history", text }` — all `.strict()`, all text kinds non-empty after trim, `text` fields via the file's existing `text()` helper, summaries via `text(2048)`.
  - ChannelMessage gains: `z.object({ type: z.literal("mirror"), token: z.string().regex(MIRROR_TOKEN), cc_session: z.string().min(1).max(64), line: MirrorLine }).strict()`
  - hello variant gains: `mirror_token: z.string().regex(MIRROR_TOKEN).optional()`
  - `export type MirrorMessage = Extract<ChannelMessage, { type: "mirror" }>;`
  - From `tests/helpers.ts`: `FakeTelegram`, `tmp`, `until`, `settle`, `OWNER`, `STRANGER`, `GROUP`, `G` (moved verbatim from `desk.test.ts`).
- Consumes: existing `text()`, `short()` helpers and union style in `protocol.ts`.

- [ ] **Step 1: Extract helpers** — move `FakeTelegram`, `tmp`, `until`, `settle`, `OWNER`, `STRANGER`, `GROUP`, `G` from `tests/desk.test.ts` into `tests/helpers.ts` with exports; `desk.test.ts` imports them. Run `npm test` — the whole existing suite passes unchanged (this is a pure move; commit it separately: `Tests: shared harness moves to tests/helpers.ts`).
- [ ] **Step 2: Write the failing tests** in `tests/mirror.test.ts`, describe `mirror protocol`:
  - `a valid line of every kind decodes` — build one MirrorMessage per kind with a 32-hex token; `decode(ChannelMessage, encode(m))` round-trips deep-equal.
  - `a bad token, an unknown kind, and an empty text are rejected` — `decode` returns `undefined` for token `"xyz"`, kind `"nope"`, `user_prompt` with `"  "`.
  - `an overlong summary is rejected` — 3000-byte summary → `undefined`.
  - `hello accepts an optional mirror_token` — with and without, both decode; wrong-format token → `undefined`.
  - `extra fields are rejected` — any kind plus `{ extra: 1 }` → `undefined` (strict).
- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/mirror.test.ts` — FAIL (types/union members missing).
- [ ] **Step 4: Implement** the protocol additions exactly as the Interfaces block pins (discriminated union on `kind` nested under the `mirror` type keeps `.strict()` composition simple).
- [ ] **Step 5: Run** `npm test` — all pass (existing suite unaffected: this task is additive).
- [ ] **Step 6: Commit** — `Protocol: the mirror line — token, cc_session, six kinds`.

---

### Task 3: Launcher mints the token

**Files:**
- Modify: `src/desk/channel.ts` (export `ENV_MIRROR` only — it lives here because `launcher.ts` already imports from `channel.ts`; the reverse would be a cycle)
- Modify: `src/desk/launcher.ts:59-67` (`runClaude`)
- Test: `tests/mirror.test.ts`

**Interfaces:**
- Produces: `export const ENV_MIRROR = "TELEDESK_MIRROR";` (channel.ts) and `export function newMirrorToken(): string` (launcher.ts — `randomBytes(16).toString("hex")`, matches `MIRROR_TOKEN`). `runClaude` sets `env[ENV_MIRROR] = newMirrorToken()` when `desk: true` and `delete env[ENV_MIRROR]` when `desk: false`.
- Consumes: `MIRROR_TOKEN` (Task 2).

- [ ] **Step 1: Failing tests** — describe `launcher token`:
  - `desk:true gives the child a fresh 32-hex token` — call `runClaude` with the repo's existing fake-claude approach (follow how `desk.test.ts` tests `runClaude`; if it spawns `env`, capture the child env — otherwise spawn `process.execPath` with `-e 'console.log(process.env.TELEDESK_MIRROR ?? "")'`), assert output matches `MIRROR_TOKEN`.
  - `two launches mint different tokens`.
  - `desk:false strips the token even when the parent has one` — parent env contains `TELEDESK_MIRROR=deadbeef…`, child sees empty.
- [ ] **Step 2: Run, verify FAIL** (`newMirrorToken` undefined / env not set).
- [ ] **Step 3: Implement** — `ENV_MIRROR` in channel.ts next to `ENV_GUARD`; `newMirrorToken()` + the two env lines in `runClaude`, mirroring how `ENV_GUARD` is set/deleted at launcher.ts:61.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `Launcher: a per-spawn mirror token in the child env, stripped when the desk is off`.

---

### Task 4: Channel hello carries the token

**Files:**
- Modify: `src/desk/channel.ts:287-296` (`runDeskChannel` hello construction)
- Test: `tests/mirror.test.ts`

**Interfaces:**
- Produces: the `hello` line sent by `runDeskChannel` includes `mirror_token` iff `env[ENV_MIRROR]` matches `MIRROR_TOKEN` (invalid or absent → field omitted).
- Consumes: `ENV_MIRROR` (Task 3), hello schema (Task 2).

- [ ] **Step 1: Failing test** — `hello carries a valid mirror token and ignores an invalid one`: start a fake socket server (see how `desk.test.ts` exercises `DaemonLink`), run `runDeskChannel` with env `{ TELEDESK: "1", TELEDESK_MIRROR: <32hex>, CLAUDE_PROJECT_DIR: tmp }` pointed at it; assert the received hello deep-includes `mirror_token`. Repeat with `"not-a-token"` → hello has no `mirror_token` key.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** in `runDeskChannel`: read + regex-check env, spread into `hello` when valid.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `Channel: hello carries the mirror token when the launcher minted one`.

---

### Task 5: `teledesk mirror-hook` — transport and classification

**Files:**
- Create: `src/desk/mirror-hook.ts`
- Modify: `src/cli.ts` (register the `mirror-hook` subcommand; add it to the help text as "the hook entrypoint Claude Code runs (not run by hand)")
- Test: `tests/mirror.test.ts`

**Interfaces:**
- Produces (Tasks 6–7 rely on these exact names):
  - `export const MIRROR_TIMEOUT_MS = 1500;`
  - `export interface HookInput { hook_event_name?: string; session_id?: string; prompt?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown; transcript_path?: string; }`
  - `export function mirrorLinesFor(hook: HookInput, env: NodeJS.ProcessEnv): MirrorMessage[]` — pure; `[]` means "nothing to send". (Plural: a Stop event yields two lines — `assistant` when there is text, then always `turn_end`.) Rules pinned here (extraction internals are Task 6):
    - requires `env.TELEDESK_MIRROR` matching `MIRROR_TOKEN` and non-empty `hook.session_id`;
    - `UserPromptSubmit` → `user_prompt` with `hook.prompt` (empty/whitespace → undefined);
    - `PreToolUse` → `tool_start` with `toolStartSummary(hook.tool_name, hook.tool_input)`;
    - `PostToolUse` → `tool_end` (`ok` per spike (a): default `hook.tool_response` present and no `error`-shaped field; builder pins from logged JSON) — **except** `tool_name === "mcp__teledesk__desk_on"` → `history` line with `extractHistory(read transcript_path)` (skip if undefined);
    - `Stop` → returns the `assistant` line when `extractTurnAssistant` yields text; the CLI additionally always sends `turn_end` after it (two lines, one connection, in order);
    - any other/unknown event → undefined.
  - `export async function runMirrorHook(stdinJson: string, env: NodeJS.ProcessEnv, socketPath: string, o?: { extractTurnAssistant?: (t: string) => string | undefined; extractHistory?: (t: string) => string | undefined }): Promise<number>` — parses stdin (bad JSON → 0, nothing sent), calls `mirrorLinesFor`, connects to `socketPath`, writes `encode(line)` per line in order, waits for drain or `MIRROR_TIMEOUT_MS`, **always resolves 0**. Connection errors, timeouts, EPIPE: 0. The optional `o` seams exist for Task 5's tests (Task 6 replaces the stubs with the real functions; the seams stay, defaulted).
  - Stub signatures Task 6 fills: `extractTurnAssistant(transcript: string): string | undefined`, `extractHistory(transcript: string, maxTurns?: number, perTurnChars?: number): string | undefined`, `toolStartSummary(toolName: string, input: unknown): string`, `toolEndSummary(response: unknown): string`, `stripChannelWrapper(text: string): string` — in this task, the two transcript functions may read the file and return `undefined` (tests for them come in Task 6); the summaries return `oneLine(clip(JSON.stringify(…), 200/300))` placeholders.
- Consumes: `ChannelMessage`/`encode`/`MIRROR_TOKEN` (Task 2), `deskPaths().socket` (existing).

- [ ] **Step 1: Failing tests** — describe `mirror-hook transport` (fake unix socket server via `createServer` on `tmp()` path, collecting decoded lines):
  - `no token, no send`: env without `TELEDESK_MIRROR`, valid UserPromptSubmit JSON → exit 0, server saw no connection.
  - `malformed stdin exits 0`: `"{"` → 0, nothing sent.
  - `unknown event exits 0 without connecting`: `hook_event_name: "SessionStart"` → 0.
  - `a prompt becomes one mirror line`: token + session_id + UserPromptSubmit → server receives `{ type:"mirror", token, cc_session, line:{ kind:"user_prompt", text } }`.
  - `Stop sends assistant-then-turn_end when the transcript has text` (fixture transcript wired in Task 6; here assert two ordered lines using a stubbed extract that returns fixed text via injection — builder may add an optional `extract` override parameter to `runMirrorHook`'s options for testability, defaulting to the real functions).
  - `a dead socket still exits 0`: socketPath pointing nowhere → resolves 0 in < `MIRROR_TIMEOUT_MS + 200`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `mirror-hook.ts` + cli.ts registration (`if (cmd === "mirror-hook")`: read stdin to string, `process.exit(await runMirrorHook(data, process.env, deskPaths().socket))`). Detach mechanism for tool events: per spike (c) — if shell-level backgrounding survived, nothing to do here (the installer handles it, Task 9); if not, add the `mirror-send` self-respawn path pinned in Task 1's fallback and have `runMirrorHook` use it for `tool_start`/`tool_end`.
- [ ] **Step 4: Run** `npm test` — pass. Also `npx tsc --noEmit` (or the repo's typecheck script) clean.
- [ ] **Step 5: Commit** — `mirror-hook: hook JSON in, one protocol line out, exit 0 whatever happens`.

---

### Task 6: `mirror-hook` — transcript and summary extraction

**Files:**
- Modify: `src/desk/mirror-hook.ts` (replace Task 5's stubs)
- Test: `tests/mirror.test.ts` (fixtures inline as template strings; no real transcripts committed)

**Interfaces:**
- Produces (behaviour pinned; Task 5 already consumes the signatures):
  - `extractTurnAssistant(transcript)`: scan JSONL lines from the end; the turn boundary is the **last `type:"user"` row whose `message.content` is a string** (tool results are user rows with array content — they don't bound); collect every `type:"assistant"` row's `message.content[].text` blocks after the boundary, in file order, joined `"\n\n"`; `undefined` if none. Byte-clipped via `headOf` to `MAX_TEXT_BYTES`; no character cleaning here — control chars and invisibles are the daemon's job (it already has `replyText`, applied in Task 7's post arms). Malformed JSONL lines are skipped, never thrown on.
  - `extractHistory(transcript, maxTurns = 5, perTurnChars = 500)`: walk the same row structure backwards for up to `maxTurns` prompt→answer pairs (prompt = string-content user row; answer = the assistant text of that turn via the same collection rule), render oldest-first as `🧑 <clip(prompt, perTurnChars)>\n\n🤖 <clip(answer, perTurnChars)>` pairs separated by `\n\n---\n\n`; `undefined` when the transcript holds no completed pair. Total clipped to `MAX_TEXT_BYTES`.
  - `toolStartSummary(toolName, input)`: `oneLine` + `clip(…, 200)` of — Bash: `input.command`; Read/Edit/Write/NotebookEdit: `input.file_path`; Task: `input.description`; Grep: `input.pattern`; Glob: `input.pattern`; WebSearch: `input.query`; default: `JSON.stringify(input)`. Undefined input → `""`.
  - `toolEndSummary(response)`: `oneLine(clip(…, 300))` of `typeof response === "string" ? response : JSON.stringify(response)`.
  - `stripChannelWrapper(text)`: removes a leading `<channel source="teledesk"[^>]*>` and trailing `</channel>` (regex, whitespace-trimmed result); returns input unchanged when unwrapped. (Used by the daemon in Task 7 — exported from here so both sides share it.)
- Consumes: `clip`, `headOf`, `oneLine`, `MAX_TEXT_BYTES` (protocol.ts).

- [ ] **Step 1: Failing tests** — describe `transcript extraction` with inline JSONL fixtures (helper `jsonl(...rows)` building rows `{ type, message: { role, content } }`):
  - `collects assistant text after the last string-content user row` — fixture: prompt, assistant text, user tool_result (array content), assistant text → both texts joined, tool_result row ignored as boundary.
  - `extractTurnAssistant returns undefined for a tool-only turn` (Review Focus 1).
  - `extractTurnAssistant output is clipped to MAX_TEXT_BYTES` (Review Focus 4) — one 70 KB text block → result ≤ `MAX_TEXT_BYTES`.
  - `malformed lines are skipped` — a fixture with a `not json` line between valid rows still extracts.
  - `extractHistory returns up to five marked pairs, oldest first` — 7-turn fixture → 5 pairs, each clipped to 500 chars, `🧑`/`🤖` marks, `---` separators; `undefined` on an empty transcript.
  - `summaries special-case Bash, Read, Task and fall back to JSON` + `stripChannelWrapper unwraps only a teledesk wrapper`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the five functions; wire `mirrorLineFor`'s history/Stop paths to the real ones (remove any Task 5 test-injection seam that's now dead, or keep it — builder's call).
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `mirror-hook: turn and history extraction from the transcript, tool summaries`.

---

### Task 7: Daemon — token binding, session binding, chat mirror

**Files:**
- Modify: `src/desk/router.ts` (handle(), bind()/attach(), endSession(), route()'s owner-text forward, DeskLimits)
- Test: `tests/mirror.test.ts`

**Interfaces:**
- Consumes: `MirrorMessage`, hello's `mirror_token` (Tasks 2/4); `stripChannelWrapper` (Task 6); existing `post()`, `take()`, `replyText()`, `REPLY_MARK`, `topicOf` row shape.
- Produces (Task 8 builds on these):
  - `export const MIRROR_MARK = "🧑 ";` `export const HISTORY_MARK = "📜 ";` `export const HISTORY_COOLDOWN_MS = 120_000;`
  - `interface MirrorBatch { toolName: string; messageId: number; starts: number; ends: number; lastSummary: string; lastOk: boolean; }` (exported for Task 8 tests)
  - `interface MirrorSession { batch?: MirrorBatch; gateOpen: boolean; sent: number[]; lastInjected?: string; lastHistoryAt: number; }`
  - DeskRouter private state: `mirrorRows: Map<string, number>` (token → row id, set in `bind()` from `conn.hello?.mirror_token`, deleted in `endSession`), `mirrorCc: Map<string, string>` (token → first `cc_session`), `mirrorState: Map<number, MirrorSession>` (cleaned in `endSession`).
  - `DeskLimits` gains `mirrorSendsPerMinute: number` (DEFAULT_LIMITS: 60). Edits do not count against it.
  - `private async mirrorLine(m: MirrorMessage): Promise<void>` — dispatched from `handle()` **before** the `topicOf` check (mirror connections have no hello): resolve row via `mirrorRows`; drop silently if unknown token, row not live, or no topic; bind/verify `cc_session` (first line wins; mismatch → drop, unless spike (b) flipped to accept-and-mark, then prefix bubble text `⤷ nested `); then per kind:
    - `user_prompt`: `stripChannelWrapper(text)`; if it equals `lastInjected` → drop (phone echo); else `gateOpen = true`, post `replyText(stripped)` via `post()` with `shape: (p) => MIRROR_MARK + p` and `before: async () => { await this.mirrorPace(rowId, false); }` (the async wrapper matters: `mirrorPace` resolves boolean, `before` must resolve void).
    - `assistant`: `gateOpen = true`; post `replyText(text)` with `shape: (p) => REPLY_MARK + p`, same pacing form.
    - `history`: skip if `now - lastHistoryAt < HISTORY_COOLDOWN_MS`; else post `HISTORY_MARK + "Recent chat:\n\n" + text`, set `lastHistoryAt`.
    - `turn_end`: `gateOpen = false`; close any open batch (Task 8's `closeBatch`).
    - `tool_start`/`tool_end`: Task 8.
  - `private async mirrorPace(rowId: number, droppable: boolean): Promise<boolean>` — window `mirrorState.sent` via existing `take(window, this.lim.mirrorSendsPerMinute)`; over budget: `droppable` → return false (caller skips), else wait (`setTimeout` 500 ms, retry) and return true.
  - In `route()`, where the owner's text is forwarded to the channel (`this.write(conn, { type: "message", … })`): record `mirrorState.get(rowId).lastInjected = text` (create the state entry lazily).
- Post helper reuse: `post()` paces per-connection via the caller's `before` — mirror passes `mirrorPace` instead; no change to `post()` itself.
- Queue bound note: a chat line waiting on budget holds its transient connection, so `MAX_CONNECTIONS` (32) is the de-facto chat queue bound. That's safe: a turn produces at most two chat lines (prompt + answer) plus one snapshot, and tool lines never wait (droppable).

- [ ] **Step 1: Failing tests** — describe `daemon chat mirror` (build a `DeskRouter` on a tmp socket with `FakeTelegram` + `SqliteDeskState`, connect a fake channel, send hello with `mirror_token`, let it attach — follow `desk.test.ts`'s existing router harness; then open a second short-lived connection per mirror line, as the CLI does):
  - `a prompt line posts with the mirror mark` → FakeTelegram `sent` contains `🧑 hello`.
  - `phone-injected text does not echo` → simulate the injection the way `desk.test.ts` already drives owner messages (`router.onUpdate({ kind: "message", … })` from OWNER in the session's topic, which forwards `type:"message"` to the channel and records `lastInjected`), then a `user_prompt` line with `<channel source="teledesk" message_id="1">hello</channel>` → nothing posted.
  - `an assistant line posts with the reply mark, chunked` → text > CHUNK arrives in parts, each starting `🤖 `.
  - `mirror lines with a foreign cc_session are dropped` (Review Focus 3) → first line binds, second with different `cc_session` posts nothing.
  - `an unknown token is dropped silently` — no post, connection not errored.
  - `history posts once inside the cooldown` → two `history` lines back-to-back → one `📜 ` post.
  - `over budget, chat waits but never drops` → limits `{ mirrorSendsPerMinute: 2 }`, three prompt lines → all three eventually posted (use `until`).
  - `endSession clears the token mapping` → after channel bye, a mirror line with the old token drops.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** exactly as pinned. (`handle()` gets `if (m.type === "mirror") { await this.mirrorLine(m); return; }` after the `bye` branch; `tool_start`/`tool_end` kinds stubbed to no-op until Task 8 — keep the switch exhaustive so Task 8 only fills arms.)
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `Daemon: the mirror chat path — binding, phone-echo dedupe, marks, budget`.

---

### Task 8: Daemon — the order-tolerant tool batch machine

**Files:**
- Modify: `src/desk/router.ts` (fill the `tool_start`/`tool_end` arms; add `closeBatch`)
- Test: `tests/mirror.test.ts`

**Interfaces:**
- Consumes: `MirrorBatch`/`MirrorSession`/`mirrorPace` (Task 7); `tg.edit`, `tg.send` (existing).
- Produces:
  - `private async closeBatch(rowId: number): Promise<void>` — if `batch` open: final edit `✅ <toolName> ×<max(starts,ends)>` (or `❌` when `lastOk === false`), `… — <lastSummary>` appended when non-empty; on edit failure send that text as a new message; clear `batch`.
  - Gate rule (the resurrection guard): when `gateOpen === false`, `tool_start` and `tool_end` are **dropped** — a closed turn's stragglers never reopen or spawn bubbles; chat kinds set `gateOpen = true` (Task 7), so a new turn's prompt reopens the gate before its tools flow.
  - `tool_start` arm: if `gateOpen` false → drop. If open batch with same `toolName` → `starts++`, edit bubble to `<icon> <toolName> ×<max(starts,ends)> … <summary>`. Else → `closeBatch`, then `send` a new bubble `<icon> <toolName>: <summary>` (droppable pacing: if `mirrorPace(rowId, true)` returns false, skip entirely), store `{ toolName, messageId, starts: 1, ends: 0, lastSummary: summary, lastOk: true }`.
  - `tool_end` arm: no open batch, or `toolName` differs → ignore (ephemeral). Else `ends++`, `lastSummary = summary`, `lastOk = ok`, edit to `<icon> <toolName> ×<max> … <summary>` (counters monotonic: a duplicate or out-of-order end never decrements or regresses `lastSummary` — compare `ends` before/after and keep the newer text only when `ends` grew).
  - Every `edit` wrapped: on throw, `send` the intended text as a new message and re-point `batch.messageId` (Review Focus 5).
  - `export const TOOL_ICONS: Record<string, string>` — `Bash: "🖥", Read: "📖", Edit: "✏️", Write: "📝", Grep: "🔍", Glob: "🔍", Task: "🧵", WebSearch: "🌐"`, default `"🔧"` (helper `toolIcon(name)`).
- Bubble templates are pinned above; wording polish within them is the builder's.

- [ ] **Step 1: Failing tests** — describe `tool batches`:
  - `three reads collapse into one edited bubble` → start/read, end, start, end, start, end: exactly one `send` (icon `📖`), three `edit`s, final text contains `×3`.
  - `a type change closes the batch and opens a new bubble` → Read, Read, Bash: two sends; first batch's closing edit contains `✅`.
  - `turn_end closes the batch; a late tool_start is dropped` (resurrection guard) → after `turn_end`, a `tool_start` posts nothing; a following `user_prompt` reopens the gate and the next `tool_start` bubbles normally.
  - `out-of-order ends never regress the counter` → end, end, start (shuffled): `×` count is monotonic across recorded edits.
  - `edit failure falls back to a new message and repoints the batch` (Review Focus 5) → FakeTelegram edit throws once → the result text appears as a `send`, and a subsequent end edits the NEW message id.
  - `over budget, tool bubbles drop while chat flows` → `mirrorSendsPerMinute: 1`: first tool bubble sends, second drops, a following `user_prompt` still posts.
  - `a failed tool closes with ❌` → `ok: false` end → closing edit starts `❌`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the arms + `closeBatch` + `TOOL_ICONS`.
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `Daemon: collapsed tool batches — send once, edit per completion, never resurrect`.

---

### Task 9: Installer — the four hooks

**Files:**
- Modify: `src/desk/install.ts` (+ `install()`/`uninstall()`), help text in `src/cli.ts` if it enumerates what install does
- Test: `tests/mirror.test.ts` (pure merge functions) + `tests/desk.test.ts` (install/uninstall against a fake home, following its existing pattern)

**Interfaces:**
- Produces:
  - `export const HOOK_MARKER = "teledesk mirror-hook";`
  - `export function hookEntries(backgroundTools: boolean): Record<string, unknown>` — the settings `hooks` object for the four events. Guard prefix on every command: `[ -n "$TELEDESK_MIRROR" ] || exit 0; `. Chat commands: `…; teledesk mirror-hook` (foreground). Tool commands, when `backgroundTools` (spike (c) default true): `…; teledesk mirror-hook </dev/stdin >/dev/null 2>&1 & exit 0`; else the foreground form. PreToolUse/PostToolUse entries carry `"matcher": "*"`.
  - `export function mergeHookSettings(settings: unknown, entries: Record<string, unknown>): unknown` — deep-merges into an existing settings object, never duplicating an entry whose command contains `HOOK_MARKER` (replace ours in place, preserve everything else byte-for-byte in structure).
  - `export function removeHookSettings(settings: unknown): unknown` — strips only entries whose command contains `HOOK_MARKER`, pruning emptied arrays/objects.
  - `install()` additionally: read `~/.claude/settings.json` (missing → `{}`; unparseable → leave untouched and report `skipped`), `mergeHookSettings` with `hookEntries(<spike c>)`, write back, report `changed`. `uninstall()` mirrors with `removeHookSettings`.
- Consumes: spike (c) verdict (Task 1 record).

- [ ] **Step 1: Failing tests**:
  - `merge into empty, into existing unrelated hooks, and twice in a row` — idempotent: third run's output deep-equals second's; foreign hooks survive untouched.
  - `remove strips only marked entries` — foreign entries and empty-array pruning asserted.
  - `unparseable settings are left alone` — file content unchanged, report says skipped.
  - install/uninstall against a fake home (tmp): settings.json ends up with exactly four event keys containing `HOOK_MARKER` commands, and uninstall removes them.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — pass.
- [ ] **Step 5: Commit** — `Installer: four guarded hooks, idempotent merge, clean uninstall`.

---

### Task 10: Kill the reply path, integration cycle, docs, version

The deletion task — everything above shipped additively; this removes the model-mediated path and proves the whole cycle end to end.

**Files:**
- Modify: `src/desk/protocol.ts` (drop the `reply` variant), `src/desk/channel.ts` (reply tool, INSTRUCTIONS, desk_on response text), `src/desk/launcher.ts` (`REPLY_TOOL`, `DESK_TOOLS`), `src/desk/router.ts` (reply branch at ~382; keep `replyText` — check references first, it cleans mirror text too if Task 7 reused it), `tests/desk.test.ts` (reply tests → deletion + tolerance test), smoke script (find it: `grep -rn "reply" scripts/ smoke* 2>/dev/null`; update its assertions), `README.md` (desk section, security model, troubleshooting), `package.json` (minor version bump)
- Test: `tests/mirror.test.ts` (integration)

**Interfaces:**
- Produces: the shipped behaviour. Pinned copy:
  - `INSTRUCTIONS` becomes exactly: `"The owner can open a Telegram topic for this session with /desk (the desk_on tool) and hide it with /desk off (desk_off)."` — nothing else; no outbound guidance of any kind.
  - `desk_on` welcome response becomes: `` `Desk is on: this session's topic is "${r.topic}".` `` (the "owner reads Telegram… reply tool" sentence is deleted).
  - `DESK_TOOLS` = the two desk tools only.
- Consumes: everything above.

- [ ] **Step 1: Failing integration test** — describe `mirror cycle`: router + FakeTelegram + a fake channel connection (hello with token) + short-lived mirror connections, asserting the full spec scenario in order: `user_prompt "make it so"` → `🧑 make it so`; three `tool_start`/`tool_end` Read pairs → one send + edits ending `✅ Read ×3`; `tool_start` Bash → new bubble; `turn_end` → `✅ Bash` close; `assistant "done."` → `🤖 done.`. Then the deletion tests: `a stale reply line is ignored, not fatal` (write a `{"type":"reply",…}` line to the socket after upgrade → connection survives, nothing posted, log line emitted); `ListTools returns exactly desk_on and desk_off`; `CallTool reply → isError "unknown tool"`.
- [ ] **Step 2: Run, verify FAIL** (reply still wired).
- [ ] **Step 3: Implement the deletions** as pinned; update/remove the old reply tests in `desk.test.ts` (the decode-tolerance behaviour replaces them); fix the smoke script; README desk section rewritten around the mirror (behaviour, what the phone sees, hooks list), security-model section gains the token paragraph from the spec, troubleshooting gains "phone is silent" (desk off? daemon down? session relaunched — token is per-spawn, hooks need the launching env) **and the upgrade note: restart `teledesk.service` after upgrading — an old daemon's strict hello schema rejects the new `mirror_token` field, and the hello skew breaks attach until the daemon is current (running sessions survive the restart via the existing 90 s reconnect grace)**; audit `DESK_COMMAND` in `install.ts` — it references no reply tool, so the spec's desk.md requirement is already met; leave the text unchanged; `package.json` minor bump.
- [ ] **Step 4: Run** `npm test` + typecheck + the smoke script per README — all green.
- [ ] **Step 5: Manual verify (with Dylan, real desk)** — one real session: terminal prompt appears on the phone; phone prompt appears in the terminal without echoing back; a multi-tool turn shows collapsed bubbles; `/desk` mid-session posts the 📜 snapshot; `/desk off` silences; a permission prompt still relays and answers. While the multi-tool turn runs, watch the topic for 429-driven edit stalls (spec spike item 5 — the collapse pattern's real-world edit rate; if Telegram throttles, lower `mirrorSendsPerMinute` or widen the collapse). Tick only after all six observed.
- [ ] **Step 6: Commit** — `Mirror ships: reply is gone, the desk is a wiretap` (+ version).

---

## After the last task

- Update the vault: `Projects/Claude Telegram Bot.md` (mirror shipped section), memory `project_claude_telegram_desk_diagnosis_2026_10_13.md`, and `MEMORY.md`'s teledesk line; run the gbrain sync + the separate `.claude-memory` import command.
- Push per Dylan's standing preference; PR only if he asks (single-maintainer repo, sentence-style commits straight to main is the established pattern).
