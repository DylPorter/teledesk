# Spike: the hook facts the mirror protocol depends on

**Executed:** 2026-10-20 (overnight run; plan date 2026-10-18). **Harness:** Claude Code 2.1.304, Linux (Fedora 43), model traffic via the qwen proxy. **Scratch rig:** `/tmp/hook-spike/.claude/settings.json` (project-scoped only — global settings untouched). **Authority:** this record gates Tasks 5/6/7/9; where a fact is UNVERIFIED, the plan default + fallback stay in force.

## Method

Four `claude -p` runs in `/tmp/hook-spike` (always with `--dangerously-skip-permissions` so tool calls execute; echo-only commands, no repo access):

| Run | Prompt (abridged) | Answers |
|---|---|---|
| A | `Run bash echo one, then read note.txt, then answer … done` | (a) shapes + event set/order; first (c) evidence |
| B | `Use the Agent tool to spawn a general-purpose subagent … echo sub` | (b) subagent firing + session_id |
| CF | `Run exactly this bash command once …: date +%s.%N > …/f-toolstart.txt ; echo one` | (c) timed proof; (f) wait semantics |
| D | `Call the MCP tool named mcp__cloak-search__search_web exactly once …` | (d) MCP firing mechanism |

Rig notes / deviations from the brief's literal rig (all deliberate):

- Logger hook: `jq -c '. + {"_rcv": now}' >> /tmp/hook-spike/log.jsonl` instead of bare `cat >> log.jsonl`. Same payloads, but one compact line each with a **rig-added** `_rcv` (hook-spawn wall clock) for ordering evidence. `_rcv` is NOT a Claude Code field; it appears in excerpts below and must be ignored by implementers.
- Hooked events: the brief's four (`UserPromptSubmit`, `PreToolUse` matcher `*`, `PostToolUse` matcher `*`, `Stop`) **plus `SubagentStop`** — needed because question (b) asks whether a Stop-like event fires for the subagent.
- `PreToolUse` second entry varied per run: runs A/B used the brief's `(sleep 30; echo survived >> …/log.jsonl) </dev/null >/dev/null 2>&1 & exit 0`; run CF replaced it with a timestamped `sleep 60` variant writing `c-timeline.txt`, plus a third entry `{ cat >/dev/null; echo FHOOK_START …; sleep 5; echo FHOOK_END …; }` for (f). Run D used the CF settings unchanged.

Probes (d)-for-`desk_on` and (e) need a live desk session + Dylan's phone; owner asleep → see those sections: UNVERIFIED, defaults kept (ledger Ruling 2). No Telegram/teledesk/daemon surface was touched by any probe.

Redaction: `/home/tdporter` → `~`; UUIDs/agent ids truncated after 8 chars with `…`. No credential-shaped values ever appear in hook payloads.

## (a) Hook JSON shapes — VERIFIED (default holds)

Every field the plan's `HookInput` assumes exists, with the assumed names. Observed exact `hook_event_name` values: `"UserPromptSubmit"`, `"PreToolUse"`, `"PostToolUse"`, `"Stop"`, `"SubagentStop"`.

**Common to every event:** `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `hook_event_name`. Per event, additionally:

- `UserPromptSubmit`: `prompt`
- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `effort`
- `PostToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `duration_ms`, `effort`
- `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`, `effort`
- `SubagentStop`: `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`, `effort`

Run A excerpts (redacted, `_rcv` absent = pre-`_rcv` rig):

```json
{"session_id":"8c781f02-…","transcript_path":"~/.claude/projects/-tmp-hook-spike/8c781f02-….jsonl","cwd":"/tmp/hook-spike","prompt_id":"94b154ea-…","permission_mode":"bypassPermissions","hook_event_name":"UserPromptSubmit","prompt":"Run bash echo one, then read note.txt, then answer with just the word done"}

{"…":"common fields","hook_event_name":"PreToolUse","effort":{"level":"high"},"tool_name":"Bash","tool_input":{"command":"echo one","description":"Print \"one\""},"tool_use_id":"toolu_…"}

{"…":"common fields","hook_event_name":"PostToolUse","effort":{"level":"high"},"tool_name":"Bash","tool_input":{"command":"echo one","description":"Print \"one\""},"tool_response":{"stdout":"one","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},"tool_use_id":"toolu_…","duration_ms":223}

{"…":"common fields","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/hook-spike/note.txt"},"tool_response":{"type":"text","file":{"filePath":"/tmp/hook-spike/note.txt","content":"spike file content: alpha bravo\n","numLines":2,"startLine":1,"totalLines":2}},"duration_ms":5}

{"…":"common fields","hook_event_name":"Stop","effort":{"level":"high"},"stop_hook_active":false,"last_assistant_message":"done","background_tasks":[],"session_crons":[]}
```

Facts downstream implementers should code against, beyond the defaults:

- **`tool_response` shape is per-tool.** Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected}`. Read: `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}`. MCP tools: **an array of content blocks**, e.g. `[{"type":"text","text":"Search Results …"}]` (run D). Extraction in Task 5 must not assume one shape.
- **`prompt_id` is constant across every event of one prompt-turn** (all of run A: `94b154ea-…`; run D: one unique value across 6 events). A turn-scoped dedupe key that survives `Stop` — use it next to `session_id`.
- **`session_id` is unique per `claude -p` invocation**, stable for all events of that run.
- `transcript_path` = `~/.claude/projects/<cwd-encoded>/<session_id>.jsonl` (cwd encoding: `/tmp/hook-spike` → `-tmp-hook-spike`).
- `permission_mode` observed as `"bypassPermissions"` under `--dangerously-skip-permissions`.
- Event order per run: `UserPromptSubmit` → (`PreToolUse` → `PostToolUse`)×n → `Stop`. Run CF wall clocks: UPS `_rcv` 1476.8 → Pre 1482.3 → Post 1487.6 → Stop 1490.5 → process exit 1491.2.

**Fallback applied:** none — adapt nothing; the defaults were right. Treat the extra fields above as available, not required.

## (b) Subagent tool calls fire parent hooks with the parent session_id — VERIFIED (default holds)

Run B: parent asked to spawn a `general-purpose` subagent running `echo sub`. Appended event order: `UserPromptSubmit` → `PreToolUse(Agent)` → `PreToolUse(Bash, agent)` → `PostToolUse(Bash, agent)` → `SubagentStop` → `PostToolUse(Agent)` → `Stop`.

- **Pre/PostToolUse DO fire for the subagent's `Bash` call**, carrying `agent_id` and `agent_type` alongside the parent fields.
- **`session_id` is identical to the parent's** — one unique value across all run-B events: `5a4ff1ab-…`. The subagent's own id is `aeb5ca0c…` (`agent_id`); its transcript nests under the parent session:

```json
{"session_id":"5a4ff1ab-…","transcript_path":"~/.claude/projects/-tmp-hook-spike/5a4ff1ab-….jsonl","…":"common","hook_event_name":"PreToolUse","agent_id":"aeb5ca0c…","agent_type":"general-purpose","tool_name":"Bash","tool_input":{"command":"echo sub","description":"Print the word sub"},"tool_use_id":"toolu_…"}
```

- **A Stop-like event fires for the subagent: `SubagentStop`**, before the parent's `PostToolUse(Agent)`:

```json
{"session_id":"5a4ff1ab-…","…":"common","agent_id":"aeb5ca0c…","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":false,"agent_transcript_path":"~/.claude/projects/-tmp-hook-spike/5a4ff1ab-…/subagents/agent-aeb5ca0c….jsonl","last_assistant_message":"done","background_tasks":[],"session_crons":[]}
```

- The subagent's `Bash` `PostToolUse` carries `duration_ms` + `tool_response` exactly like a parent call (`{"stdout":"sub",…}`).

**Fallback applied:** none. The default ("fire, parent's session_id") holds → Task 7's `cc_session` binding rule stays as planned; no accept-and-mark flip, no `⤷ nested ` prefix needed for binding (though prefixing subagent-origin lines remains a display option — `agent_id`/`agent_type` in the payload is the discriminator). Task 9 does NOT need `SubagentStop` for coverage; add it only if turn-close semantics for subagents are wanted.

## (c) Backgrounded hook child survives and completes — VERIFIED (default holds)

Form under test: `(sleep N; echo … >> file) </dev/null >/dev/null 2>&1 & exit 0` as a `PreToolUse` hook command.

- **Runs A and B:** at the instant each `claude -p` process exited, `log.jsonl` contained only the 6 (A) / 7 (B) JSON event lines — zero `survived` lines. Both pairs then appeared afterwards (lines 7–8, 16–17), each exactly ~30 s after their `PreToolUse` fired. Completion strictly after parent death.
- **Run CF (precise, epoch wall clocks in `c-timeline.txt`):**

```
RUNSTART 1792481471.25
CHILD_START 1792481482.32     ← child forked by the PreToolUse hook, run in progress
RUNEXIT  1792481491.17 rc=0   ← claude -p process gone
CHILD_DONE 1792481542.36      ← = CHILD_START + 60.03 s; 51.2 s after the parent died
POLL_HIT 1792481543.28        ← poll (2 s steps, 90 s budget) saw the line land
```

- Verification was by **timeline ordering + polling**. (The `pgrep -ax 'sleep 60'` line captured at exit read `children_live_at_exit=0` — that instrument was wrong, `-x` without `-f` matches `comm`, not the command line; the timestamp evidence above is the load-bearing proof and is unambiguous.)

Caveats for the mirror: the child survives but is orphaned/reparented — it has no session left behind it, so the payload must be fully captured into the child (or its target file) before the hook exits, and its stdout/stderr must be redirected (the tested form redirects both). The 60 s default hook timeout did not kill the orphan (timeout governs the hook process, which exits ~0 s; `CHILD_DONE` arrived at 60.03 s).

**Fallback applied:** none. The hook-side self-detach in Task 5/6's installer works as planned; the CLI `mirror-send` respawn fallback is NOT needed.

## (d) PostToolUse for MCP tools — mechanism VERIFIED; `desk_on` itself UNVERIFIED (default kept)

**Verified (run D):** tool hooks fire for MCP calls. `tool_name` is the exact registered name, `mcp__<server>__<tool>` — here `mcp__cloak-search__search_web`; both `PreToolUse` and `PostToolUse` fired for it, `tool_input` the call args as an object, `tool_response` the MCP content **array**, `duration_ms` present (3049):

```json
{"…":"common","hook_event_name":"PostToolUse","tool_name":"mcp__cloak-search__search_web","tool_input":{"query":"hook test","engine":"duckduckgo"},"tool_response":[{"type":"text","text":"Search Results (Engine: DuckDuckGo)\n\n[Result 1]\nTitle: …"}],"duration_ms":3049}
```

**UNVERIFIED specifically for `mcp__teledesk__desk_on`:** that requires a real desk session (plus Dylan's phone for the `/desk` turn); per Ruling 2 the probe was skipped — no Telegram, no daemon, no `/desk`, no `~/.local/share/teledesk` touched. There is no structural reason desk-on would differ (same hook engine, same name form), but no observed `desk_on` payload exists in this record.

**Verdict:** keep the plan default ("fires") → the 📜 capped snapshot may ride a `PostToolUse` matcher `mcp__teledesk__desk_on`. **Contingent fallback (plan, unchanged):** if field-testing after wake shows it doesn't fire, ship the history kind dormant (protocol stays, no trigger), record `/desk` as forward-only — and do NOT move extraction daemon-side (no transcript access there).

Implementer note from run D: this harness deferred MCP tools behind a `ToolSearch` gate — the model first called `ToolSearch` (`tool_input.query` `"select:mcp__cloak-search__search_web"`, response keys `matches,query,total_deferred_tools`) and that call fired its own Pre/Post events. Harmless for the snapshot trigger, but the mirror router will see extra `tool_name:"ToolSearch"` events; filter by exact tool_name matcher, don't process everything `*` reaches blindly.

## (e) UserPromptSubmit for channel-injected (phone) messages — UNVERIFIED (default kept)

Needs a live desk topic + a message from Dylan's phone; owner asleep, and simulating by *typing* wrapper-shaped text proves nothing about the injection path. Per Ruling 2: no probe run.

**Verdict:** keep the plan default — **fires, text wrapped in `<channel source="teledesk" message_id="…">…</channel>`** (the wrapper form is what the desk daemon passes; Task 5's `stripChannelWrapper` is built for it). **Contingent fallback (plan, unchanged):** if it turns out not to fire for injected messages, Task 7's dedupe simply stays a harmless no-op. Nothing else in the plan depends on (e).

Field-level corroboration that exists (from (a), verified runs): every `UserPromptSubmit` carries `prompt` + `prompt_id` + `session_id`, and `prompt_id` distinguishes turns within a session — so once a desk session is exercised, phone-vs-terminal turns are tellable from `prompt` content (wrapper present or absent) alone.

## (f) CC waits on PreToolUse exit before running the tool — VERIFIED (default holds)

Run CF instrument: `PreToolUse` slow hook `{ cat >/dev/null; echo FHOOK_START …; sleep 5; echo FHOOK_END …; }`, and the tool itself stamped its own start inside `tool_input.command` (`date +%s.%N > …/f-toolstart.txt ; echo one`).

```
PreToolUse hook spawn (_rcv)   1792481482.32
FHOOK_START                    1792481482.33   (same ms as spawn)
FHOOK_END (after sleep 5)      1792481487.36
tool's own date stamp          1792481487.58   ← tool started here
PostToolUse hook spawn (_rcv)  1792481487.59
```

The tool ran **5.26 s after the hook event and 0.22 s after the slow hook exited** — the 5 s was paid in full before execution; 0.22 s is hook-teardown + spawn overhead. CC blocks tool execution on PreToolUse completion. (Also observed: sibling hook commands for the same event start ~1 ms apart → **hook commands run in parallel with each other**, all before the tool starts.)

**Fallback applied:** none — but this is why the mirror's hooks must background *everything* and `exit 0` immediately: any synchronous work in a PreToolUse hook adds 1:1 to every tool call's latency.

## Consequences for later tasks (one line each)

- **T5/6 `HookInput`:** code against the field lists in (a); `tool_response` union-typed (Bash object / Read `{type,file}` / MCP array); `prompt_id` available for turn keys; ignore `_*` fields (rig artifact).
- **T7 binding:** parent-`session_id` rule as planned (b); no nested-accept flip; `agent_id`/`agent_type` mark subagent-origin lines.
- **T8 installer detach:** `cmd & exit 0` survives (c); the CLI-respawn fallback stays unexecuted.
- **T9 hooks set:** four events + `SubagentStop` exist and fire; MCP matcher `mcp__teledesk__desk_on` structurally works (d) — field-confirm on desk wake before wiring the snapshot to it, else history dormant.
- **Latency budget (all):** PreToolUse blocks tools (f) → mirror sends are async-only.
- **Open items to field-verify with Dylan awake:** (d) actual `desk_on` event, (e) injected-message `UserPromptSubmit`.
