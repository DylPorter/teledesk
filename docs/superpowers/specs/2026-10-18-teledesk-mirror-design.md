# teledesk mirror — the desk becomes a wiretap, not a participant

Date: 2026-10-18 · Status: proposed · Repo state at writing: `96904d9`, `src/desk/` clean

## Intent and why

Today the desk's outbound path runs **through the model**: `channel.ts` injects an
`INSTRUCTIONS` block into the system prompt ("They read Telegram, not this terminal:
anything you want them to see must go through the reply tool") and exposes a `reply`
tool. The model therefore decides what the phone sees — and the instruction is
origin-blind, so a prompt typed **in the terminal** gets answered **to Telegram**,
hijacking the terminal conversation. Observed live 2026-10-17 (nbafl-studio poster
session: agent dispatched a 23h background job, then delivered the result via `reply`
and left a one-liner in the terminal).

The fix (Dylan's direction, 2026-10-18): **the agent must never realise Telegram
exists.** The desk becomes a pure-code mirror of the chat, both directions:

- phone → terminal: already pure code (daemon → `notifications/claude/channel` →
  injected user turn). Unchanged.
- terminal → phone: **new** — hooks copy the conversation to the topic. No model
  judgment anywhere in the loop.

Inbound is already this shape; permission relays already are (`PermissionRequest`
handler in `channel.ts`, model never sees them). Only outbound chat was
model-mediated, and that mediation is what broke.

## Goals

1. The Telegram topic mirrors the session chat: Dylan's prompts (typed anywhere),
   the agent's final answers per turn, and collapsed tool-progress bubbles.
2. Zero model involvement in outbound: no `reply` tool, no Telegram-aware
   instructions. The agent answers in the terminal, always, as if alone.
3. Hooks are inert and free in non-desk sessions (no node boot, no latency).
4. A failing mirror degrades to silence — it must never block, slow, or error a
   session. Wiretap rule: observed, never load-bearing.
5. `/desk` on/off, topic lifecycle (quiet hide, 7d sweep, same-topic reopen),
   and permission-prompt relay all keep working exactly as today.

## Non-goals / anti-goals

- Not a streaming mirror: no partial assistant text mid-generation. Turn-end only.
- Not harness-agnostic: CC-only, per the 2026-10-15 decision
  (`reference_agent_harness_desk_surfaces`).
- **Anti-goal:** any design where the model chooses what the phone sees. If a
  future feature tempts you to re-add an outbound tool, that's the bug returning.
- **Anti-goal:** hooks that can fail a session. Every hook path exits 0.

## Decided behaviour (Dylan, 2026-10-18)

1. **True mirror, both surfaces carry the whole conversation.** Terminal-typed
   prompts appear on the phone; phone-typed prompts appear in the terminal
   (already true). One chat, two windows.
2. **Progress = collapsed batches, not live editing.** One Telegram message per
   *run of consecutive same-type tool calls*: send on first call, **edit** that
   same message as the batch progresses/completes, new message when the tool type
   changes. Dylan explicitly rejected live-editing a single message across cycles
   ("those cycles get fucked up") and rejected per-tool-call granularity
   (a 50-tool turn = 50 bubbles). Send-then-edit per batch, rinse and repeat.
3. **Capped snapshot at activation.** `/desk` on an already-running session first
   mirrors the recent chat — last ≤5 turns, prompts + final answers, truncated —
   as one context block, then live-mirrors forward. Chosen over forward-only
   (Dylan, 2026-10-18); backfill is the one feature that can't be retrofitted
   daemon-side, because only the hook side ever sees `transcript_path`.

## Architecture

```
terminal prompt ─┐                      ┌─ UserPromptSubmit hook ─┐
phone prompt ────┤→ Claude Code session ┤─ PreToolUse hook ───────┤→ teledesk mirror (CLI, stateless)
                 │   (model sees only    │─ PostToolUse hook ──────┤        │ unix socket, 1 line, exit 0
                 │    a normal chat)     └─ Stop hook ─────────────┘        ↓
                 └→ transcript JSONL ←── Stop hook reads last assistant text
                                                                    daemon (router.ts)
                                                              token → session row
                                                              batch state machine
                                                              Telegram send/edit → topic
```

### Token correlation (how a hook finds its topic)

- `launcher.ts` (`teledesk code`) generates a per-spawn token
  (`crypto.randomBytes(16).toString("hex")`) and sets `TELEDESK_MIRROR=<token>` in
  claude's env (alongside the existing `TELEDESK=1`).
- Hooks inherit claude's env → the mirror CLI reads the token from env.
- The channel server (`desk-channel`) is also a claude child → it reads the same
  env var and includes `mirror_token` in its `hello`. The daemon stores it on the
  session row. No change to `desk-mcp.json` (which deliberately carries no env —
  the config file alone must not enable anything).
- Daemon lookup: mirror line arrives → find row by token → if none (desk off,
  session gone, stale token) **drop silently**.
- Token is a secret capability (write to a phone-visible topic). 128-bit random,
  memory-only in the daemon, never logged.

### Protocol (`protocol.ts`)

New `ChannelMessage` variant, used only by the short-lived mirror CLI (not the
persistent channel link):

```
{ type: "mirror", token: <128-bit hex>, session_id, kind, ...payload }
kind: "user_prompt" { text }
    | "assistant"   { text }
    | "tool_start"  { tool_name, summary }
    | "tool_end"    { tool_name, ok, summary }
    | "turn_end"    {}
    | "history"     { text }   // capped context snapshot, sent once on desk_on
```

All text fields bounded (reuse `text()` / `short()`). `session_id` is the Claude
Code session UUID from the hook JSON, on every line — see Session binding below.
The `reply` variant and its router branch (`router.ts:382`) are **deleted**;
`REPLY_MARK` ("🤖 ") is kept and reused for mirrored assistant text.

### Mirror CLI (`teledesk mirror`)

- New subcommand; argv-shim fast-classified (`argv.ts`, per the #18 lesson) though
  it does boot node — see latency below.
- Reads the hook JSON on stdin, emits one protocol line to the desk socket, exits 0.
- **Never blocks the session — decided split (builder-check resolution):** every
  error path exits 0; socket connect + write under a ~1.5s hard timeout.
  **Chat hooks run foreground** — UserPromptSubmit and Stop fire once per turn at
  ~0.1–0.3s target (the `mirror` entrypoint is a light dedicated path, not the
  full launcher boot): imperceptible, and foreground means the chat itself is
  strictly ordered. **Tool hooks run backgrounded/detached**
  (`(teledesk mirror … &) >/dev/null 2>&1` or equivalent) — zero added latency
  per tool call (#18's lesson: node boot per spawn was the whole complaint);
  no ordering guarantee, so the daemon-side state machine is order-tolerant.
  A lost progress bubble is acceptable (ephemeral); chat bubbles are never
  backgrounded, so they're never lost or reordered.
- **desk_on extraction mode (the capped snapshot):** the PostToolUse event with
  `tool_name == "desk_on"` runs foreground, reads `transcript_path`, extracts the
  last ≤5 turns (user prompt text + assistant text blocks, each truncated to
  ~500 chars, role-marked) and sends one `history` line. No new hook event is
  needed — desk_on is itself a tool call, so PostToolUse already fires on it.
- Per-event extraction:
  - `UserPromptSubmit`: prompt text from hook JSON.
  - `PreToolUse` / `PostToolUse`: `tool_name` + compact summary from
    `tool_input` / `tool_response` (truncate: ~200 chars input, ~300 chars
    result — my call).
  - `Stop`: parse `transcript_path` JSONL from the tail, take the last assistant
    message's text blocks (skip tool_use/thinking), join, send as `assistant`,
    then `turn_end`.
- Guard in the installed hook command: `[ -n "$TELEDESK_MIRROR" ] || exit 0` —
  non-desk sessions pay one shell test, zero node boots.

### Daemon mirror router (`router.ts`)

Per session row, new state: `{ mirror_token, batch?: { tool_name, message_id, count, last_summary }, last_injected_text? }`.

Batch state machine (Dylan-approved shape):

- `tool_start`, no open batch or different `tool_name` → close any open batch,
  `send()` a new bubble (`🔧 <icon/label>: <summary>`), store `message_id`.
- `tool_start`/`tool_end`, same `tool_name` as open batch → `count++`, update
  `last_summary`, `edit()` the stored message to
  `<icon> <label> ×<count> … <last_summary>` (running counter — edit on every
  completion, my call: same volume, more useful mid-batch).
- `turn_end`, `user_prompt`, or a different-type `tool_start` → close the batch
  (final edit marks it done: `✅ … ×n`).
- **Edit failure fallback (Dylan's pattern):** if `edit()` throws (message too
  old — Telegram's ~48h window, deleted, chat moved), send the update as a new
  message and re-point the batch at it. Dangling "running…" bubbles from crashed
  sessions are accepted as harmless.

Message handling:

- `user_prompt` → **dedupe against `last_injected_text`**: if identical to the
  last text the daemon itself injected into this session (phone-typed), skip —
  Dylan's own phone message must not echo back to him. Otherwise post with a
  user-side mark (🧑 prefix — my call, mirrors `REPLY_MARK`'s convention that
  router-written text is visually distinct).
- `assistant` → post with `REPLY_MARK`, chunked via existing `chunkText`, through
  the existing `post()`/pace path.
- Rate budget: existing `sendsPerMinute: 20` is sized for deliberate replies.
  Mirror gets its own budget (my call: 60 sends/min/session; **edits don't count**
  — a collapsed batch is mostly edits). Over budget: drop tool bubbles
  (ephemeral), queue prompts/answers (small bounded queue, newest-wins on
  overflow). Tool bubbles are the pressure valve; the chat itself is never dropped.

Order tolerance (backgrounded tool events — builder-check resolution):

- Batch counters are monotonic: daemon tracks `starts_seen`/`ends_seen` per
  batch; displayed count = max of the two; late or duplicate events fold in and
  never regress the count or `last_summary`.
- **A closed batch never reopens.** A tool event arriving after its batch's
  `turn_end` (or after a different-type batch replaced it) is dropped —
  resurrecting a "running…" bubble after the ✅ close is the exact failure class
  Dylan rejected; a rare dropped late progress detail is the cheaper cost.
- `tool_end` with no open batch → ignored (ephemeral).

Session binding (nested-process defence — builder-check addition):

- Every mirror line carries the hook JSON's `session_id`. The daemon binds
  token→session_id on the first mirror line per token and drops later lines whose
  session_id differs. This filters nested `claude -p` children (test harnesses,
  spawned scripts) that inherit `TELEDESK_MIRROR` but have their own session_id —
  otherwise their traffic would land in the topic as if the parent said it.
- Dependency on spike #1: if Task-subagent hook events carry a *different*
  session_id than the parent, subagent coverage wins over nested filtering (the
  23h-background-job case is what motivated this design) — binding flips to
  accept-and-mark (bubbles tagged "nested") instead of drop. The spike decides
  which rule ships; the `session_id` field exists from day one either way.

`history` handling: posted as one context block with a distinct header (📜 — my
call), chunked via `chunkText`, before any live bubbles of that activation.
Bounded client-side; daemon re-checks against `MAX_TEXT_BYTES`.

Reviewer notes folded in (treat as requirements):

- The user-prompt dedupe must strip the harness's `<channel …>` wrapper from both
  sides before comparing (phone-injected text, if it fires UserPromptSubmit at
  all, arrives wrapped).
- Mirror pacing/rate state is keyed **per session row**, not per connection —
  mirror connections are transient, one per event.
- `desk: false` launches must strip `TELEDESK_MIRROR` from the child env (the
  launcher currently deletes only `TELEDESK`).
- Pre-upgrade sessions will still emit `reply` lines after the daemon upgrades:
  decode-and-ignore with a log line (keep the variant as a no-op or rely on the
  tolerant decode) — never crash the connection.

### Channel (`channel.ts`)

- `INSTRUCTIONS` shrinks to near-nothing — enough for `/desk` to function:
  the desk_on/desk_off tools exist and what they do. **No reply guidance, no
  "they read Telegram" framing, no outbound instructions of any kind.**
- `reply` tool deleted (ListTools + CallTool branches).
- `hello` gains `mirror_token` from `process.env.TELEDESK_MIRROR`.
- desk_on/desk_off stay model-visible tools — they're what `/desk` runs, and no
  external process can make the per-session channel dial the daemon. Residual
  Telegram-awareness (tool descriptions, the harness's own
  `<channel source="teledesk">` wrapper on injected messages) is accepted: the
  hijack mechanism was the *instruction bias plus the reply tool*, and both die.
  The wrapper reads as a from-header; with no reply tool the model has no way to
  act on it even if it notices.

### Installer (`install.ts`) + `/desk` command

- `teledesk install` additionally merges four hooks into `~/.claude/settings.json`
  (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`), each guarded by the
  env test above. Idempotent re-run updates in place; a `teledesk uninstall`
  (if one exists — builder checks) removes them.
- `~/.claude/commands/desk.md` prose updated: no mention of relaying via reply;
  `/desk` still toggles, and the mirror is described as automatic while on.

## Failure modes

| Failure | Behaviour |
|---|---|
| Daemon down / socket missing | mirror CLI exits 0 silently; session unaffected |
| Desk off | daemon has no live row for token → drops |
| Stale token (session relaunched) | old token unknown → drops |
| Telegram 429 | existing `BotApi.call` retry-after + router pacing absorbs |
| Edit fails (48h window, deleted) | fallback: new message, batch re-pointed |
| Hook CLI crash | exit 0 contract; at worst a missing bubble |
| Session dies mid-batch | dangling "🔧 running…" bubble; closed visually by the next session's traffic being separate messages — accepted |
| Background subagent tool calls | **to verify** (below); if they fire hooks, they mirror — desirable (that's the 23h-job case), but volume rides on the collapse + rate budget |
| Nested `claude -p` inherits the token | session_id binding drops mismatched lines (spike #1 may flip this to accept-and-mark) |
| Out-of-order backgrounded events | order-tolerant batch rules: monotonic counters, closed batches never reopen, late events dropped |
| Pre-upgrade session sends `reply` | decode-and-ignore with a log line; connection survives |

## To verify before/during implementation (spike list)

1. Do `PreToolUse`/`PostToolUse`/`Stop` fire for **Task-subagent** tool calls and
   turns, in the parent session's hook config — and which `session_id` do those
   events carry? (Determines whether the poster-run case is covered automatically
   or needs `SubagentStop` too, and which session-binding rule ships: parent id →
   binding safely filters nested processes; different id → accept-and-mark to
   keep subagent coverage.)
2. Does `UserPromptSubmit` fire for **channel-injected** messages? If yes, the
   daemon dedupe is load-bearing; if no, phone prompts simply never hit the CLI
   (fine — they're already on the phone).
3. Exact hook JSON field names/shapes for each event (transcript_path, tool_input,
   tool_response) against the installed CC version.
4. Whether CC waits on PreToolUse hook exit (drives the backgrounding choice).
5. editMessageText effective per-chat rate limits under the collapse pattern.
6. Transcript JSONL tail-parse robustness: last assistant message with text
   blocks, across compaction/summary rows.

## Security model delta

- New capability: whoever holds `TELEDESK_MIRROR` for a live desk session can post
  to its topic. Mitigations: 128-bit random per spawn; process-env only (never
  written to disk or logs); socket remains user-owned (`lstatSync` uid check
  already in `DaemonLink`); mirror lines can't answer permission prompts
  (separate `verdict` path, unchanged) and can't inject into the session
  (one-way).
- The phone-visible surface still requires: launcher-spawned session
  (`TELEDESK=1`) **and** explicit `/desk` activation **and** the group privacy
  check (solo group) — unchanged.
- Public-repo rule (`feedback_crewbot_public_repo_generic` applies in spirit):
  no vault paths, no personal names in code/tests/docs.

## Test plan

- Unit: protocol schema for `mirror` variants (bounds, strict); batch state
  machine (open/extend/type-change-close/turn-close/edit-fail-fallback);
  user-prompt dedupe; rate budget (drop tool bubbles, queue chat); Stop-hook
  JSONL tail extraction (fixtures incl. tool_use-only turns, compact rows).
- Integration: fake Telegram + in-memory daemon; full cycle — prompt mirrored,
  3-file read collapses to one edited bubble, answer lands with 🤖 mark,
  turn_end closes batch.
- CLI: `teledesk mirror` exits 0 with no daemon, bad stdin, unknown token;
  argv-shim classification (no regression of #18's fast path).
- Manual smoke (real session, real topic): terminal prompt → phone; phone prompt
  → terminal + no echo-back; long tool turn → collapsed bubbles; `/desk off` →
  silence; permission prompt relay unchanged.

## Out of scope (v1)

- `Notification`-hook events (idle/permission-wait bubbles) — later if wanted.
- Partial/streaming assistant text.
- Mirroring images or file attachments.
- Per-topic mute of tool bubbles (if volume still annoys: a `🔕` command in-topic
  is the natural v2 knob).

## Migration / rollout

- Version bump; `teledesk install` re-run adds hooks idempotently. Existing
  running sessions keep the old channel until relaunched (old `reply` lines from
  a pre-upgrade channel would hit a removed router branch — daemon should ignore
  unknown/removed message kinds with a log line rather than crash: builder keeps
  `decode` tolerant, it already drops malformed lines).
- README: rewrite the desk section around the mirror; security-model section
  updated; troubleshooting gains "phone is silent" (desk off? daemon down?
  token stale after relaunch?).

## Left to the builder

- Exact bubble text templates and emoji set (constraint: router-written text must
  stay visually distinct from Dylan's, per the `REPLY_MARK` convention).
- History-block formatting (role markers, per-turn truncation — defaults: ≤5
  turns, ~500 chars each).
- Truncation lengths, queue caps, and the mirror rate budget's exact numbers
  (defaults proposed above).
- Whether `SubagentStop` is needed on top of `Stop` (spike #1 decides).
- Uninstall path for hooks, if an uninstall exists.
