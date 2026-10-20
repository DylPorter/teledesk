# teledesk

**Your Claude Code sessions in Telegram topics.** Start Claude Code with `teledesk code` (or run `teledesk install` once and plain `claude` works too), then send **`/desk`** inside a session: it gets its own topic in a private Telegram group — and that topic is a **wiretap**. Your prompts appear under 🧑, Claude's answers under 🤖, and tool runs collapse into one bubble each (`📖 Read: file.md`, edited to `📖 Read ×3 …`, closed with `✅ Read ×3`); `/desk` on mid-session first posts a 📜 snapshot of the recent chat. To talk to a session from your phone, write in its topic: it lands in your terminal, and your own words are never echoed back as a new bubble. Permission prompts show up there with **Allow** and **Deny** buttons. The model itself has no send button: there is no tool that lets a session post to Telegram — only the session's hooks report what happened, and only while the desk is on. Until you send `/desk`, the session stays off Telegram entirely — no topic, no noise. Each topic is one session, like a chat list.

```
your terminal                            your phone
claude (wrapped) ──┐   /desk on:          ┌──────────────┐   Telegram   ┌──────────────────────┐
  Claude Code +    ├──▶ unix socket ────▶ │ teledesk     │ ◀──────────▶ │ group with Topics:   │
  channel server   │                      │ daemon       │   one bot    │  • api · main        │
  + 4 mirror hooks ├──▶ hook lines ─────▶ │              │              │  • web · fix-login   │
teledesk code    ──┘                      └──────────────┘              └──────────────────────┘
  (one per session)
```

It uses Claude Code [channels](https://code.claude.com/docs/en/channels-reference). Each session loads a small stdio MCP server (`teledesk desk-channel`) for inbound messages and permission prompts, and Claude Code runs four small hooks (`teledesk mirror-hook`: UserPromptSubmit, Stop, PreToolUse, PostToolUse) that report what happens in the terminal. Both speak to the daemon over a local unix socket. The daemon owns the bot, creates and reuses the topics, mirrors the session's chat into its topic, and relays owner messages, permission prompts and verdicts. It never types into your terminal and never scrapes the screen.

> **Research preview.** Channels are a Claude Code research preview, and custom channels aren't on its allowlist. So `teledesk code` loads this one with `--dangerously-load-development-channels`. Claude Code then shows **"WARNING: Loading development channels"** at every start, and you confirm with *I am using this for local development*. Channels only work in interactive sessions (not `-p`, not the Agent SDK). The protocol may change.

## Requirements

- **Linux or macOS**, with bash or zsh (the shell hook supports both; everything else is plain Node).
- **Node ≥ 22.13** (the daemon uses `node:sqlite`).
- **Claude Code ≥ 2.1.234**, interactive sessions. (`-p`/SDK runs can't load channels; they're passed through untouched.)
- A **Telegram account** and five minutes with [@BotFather](https://t.me/BotFather).

## Setup

1. **Make a bot.** Create a new bot with [@BotFather](https://t.me/BotFather). Give it to this program alone: only one program can poll a bot token.
2. **Configure.** `npm install`, then create `.env` in the repo folder:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_ALLOWED_USER_ID=<your numeric Telegram user id; @userinfobot tells you>
   ```
   Then `chmod 600 .env`: it holds the bot token.
3. **Start the daemon.** Run `npm start`, or install `systemd/teledesk.service` as a user unit (set its `WorkingDirectory` to your clone).
4. **Make the desk group** in Telegram:
   - Create a group with **just you and the bot**, and turn on **Topics** in its settings.
   - Make the bot an **admin** with the **Manage topics** right. Being an admin also lets it see ordinary messages.
   - Don't post as the group ("Remain anonymous"); those messages are ignored.
   - Send **`/desk_here`** in the group. The bot either confirms or tells you what's missing. `/desk_off` turns it off again.
5. **Put `teledesk` on your PATH.** Symlink `bin/teledesk` into e.g. `~/.local/bin`, or add `bin/` to your PATH.
6. **Hook up your shell (recommended).** Run **`teledesk install --shim`**: it adds a guarded `claude()` function to your `.bashrc`/`.zshrc` (so plain `claude` starts desk-capable; `teledesk uninstall` removes exactly what it added), installs the **`/desk`** slash command into `~/.claude/commands/`, and installs the four **mirror hooks** (UserPromptSubmit, Stop, PreToolUse, PostToolUse) into `~/.claude/settings.json`. Every hook command opens with a guard: outside a desk session (no per-spawn mirror token in the environment) it exits 0 at once and posts nothing, so the install is inert for every other Claude run. The merge is idempotent and owns only its own commands — foreign hooks that share an event (or merely mention teledesk) survive install and uninstall byte-for-byte. Open a new terminal afterwards.

   The **`--shim`** part also writes a desk-aware `claude` into `~/bin`. A shell *function* only exists in shells that read the rc file after it was written, so panes and terminals already open — and anything that spawns `claude` without a shell (`sh -c`, systemd user units, an IDE) — never sees it. A file on `PATH` is seen by all of them, so with `--shim` the desk stops depending on how a given process was launched. It is opt-in because it intercepts the binary's name machine-wide; `~/bin` is used rather than `~/.local/bin/claude`, which Claude Code's own updater rewrites on every auto-update. The shim only decides *whether to wrap*: `-p`, `--version` and subcommands go straight to the real binary, and anything it starts carries `TELEDESK_SHIM=1` so it can never re-enter itself. That classification is generated from `src/desk/argv.ts` — the same lists `teledesk code` uses — so the shell and the launcher can't disagree, and a print run never boots node to be told it isn't interactive (~0.7s saved per invocation; `tests/shim.test.ts` checks every argument vector against both). A caller that wants no part of the desk at all can set `TELEDESK_SHIM=1` itself: the shim then hands over the real binary for every argument, interactive included — which is what crewbot does for its own desk handoff, since that session already has a Telegram bridge (crewbot#1).
   - Non-interactive runs (`-p`, `--output-format`, `--version`, `mcp …`, `update` and the other subcommands) are passed straight to plain `claude` without the channel, so scripts and cron jobs are unaffected.
   - Prefer no shell changes? Skip this step and start sessions with `teledesk code` explicitly (any `claude` arguments go after it). Without the installed command file, `/desk` isn't a slash command — just ask the session to "call the desk_on tool".
7. **Use it.** Start `claude` in any folder (or `teledesk code`). The session starts **dormant**: nothing on Telegram yet. Send **`/desk`** inside the session: a topic named `<folder> · <branch>` appears in the desk group, a 📜 snapshot of the recent chat is posted into it, and from then on the topic mirrors the session live. `/desk off` stops relaying and quietly hides the topic — no message about it, nothing deleted; `/desk` brings the very same one back.
   - A second session in the same folder gets `#2`. The same folder later gets its topic back.
   - Ending the session (or killing it) changes nothing on Telegram: the topic waits for the next `/desk` in that folder.
8. **Topic sweep.** A topic whose session has been gone for 7 days (`DESK_TOPIC_TTL_DAYS` in `.env`; the sweep runs hourly) quietly leaves the group's list — closed, never deleted: `/desk` in that folder brings the same topic back with its history. Transcripts on your machine are untouched — the group just doesn't become a graveyard.

Message the bot directly for a short help text and the list of live sessions.

## What happens where

| You do | What happens |
|---|---|
| `/desk` inside a session | Its topic opens (or reopens) in the desk group, the recent chat arrives as a one-time 📜 snapshot, and from then on the session is reachable from your phone — and mirrored live into the topic |
| `/desk off` inside a session | Relaying stops, prompts go terminal-only, and the topic quietly leaves your list — no message, nothing deleted; `/desk` reopens the very same one |
| Write in a session's topic | It reaches that session only, as `<channel source="teledesk" message_id="…">` |
| The session works in the terminal | The topic mirrors it as it happens: your prompt lands under 🧑, Claude's answer under 🤖 (split into parts if long), and each tool run collapses into one bubble — the first call sends `📖 Read: file.md`, later ones edit that same message (`📖 Read ×2 …`), and the run closes with `✅ Read ×3` (or `❌`) when the tool type changes or the turn ends. Nothing teledesk writes itself ever starts with 🤖, so you can always tell Claude's words from the bot's own messages and prompts. A tool straggler from a finished turn posts nothing |
| Hooks fire while the desk is off, the daemon is down, or the session was never wrapped | Nothing at all: every mirror line carries the session's per-spawn token, and a line whose token matches no live topic is dropped silently. The hooks exit 0 whatever happens, and their command guard makes a non-desk session post nothing in the first place — never an error dialog, never a stall in your session |
| Claude wants to run a tool that needs approval | The prompt appears in the topic: the tool, what it does, and its input, field by field (nested fields too), **all of it, nothing hidden**. If it can't be shown in full (a field or the description longer than about 3,500 characters, more than 40 fields, or more than 4 messages in all), the topic says "This prompt is too long to show safely — answer it in the terminal", with no buttons, and no answer from Telegram counts for it. The terminal dialog stays open too, and whichever answer comes first wins |
| Tap Allow / Deny, or type `yes abcde` / `no abcde` | The answer goes to that session. Tapping a second time does nothing |
| Close the session | Nothing on Telegram: no announcement, the topic stays open for the next session of that folder |
| Restart the daemon | Sessions reconnect by themselves and keep their topics |
| Write in a group that isn't the desk group | The bot DMs you once (per group) that nothing there reaches a session — handy when two groups share a name |
| Leave a gone session's topic alone for 7 days | The sweep closes it — out of your list, never deleted; `/desk` reopens that very topic (TTL configurable) |

## Security model

- **Who can drive a session.** Only messages whose sender is `TELEGRAM_ALLOWED_USER_ID` reach a session. The check is on the sender's user id, not the chat id.
- **What's never passed on.** Forwarded messages, messages sent through an inline bot, posts made as the group or a channel, messages from bots, and edits are never passed to a session. Treat whoever controls your Telegram account as someone who can drive your Claude Code sessions.
- **When an answer counts.** A permission answer from Telegram is accepted only for a prompt that session raised and that was shown in full in its topic. A tap also has to come from that very message.
  - If a prompt couldn't be shown, Telegram says to answer in the terminal, and nothing typed or tapped in Telegram can answer it.
  - After a daemon restart, old buttons stop working.
  - The channel server also drops any answer for a request its own session didn't make.
- **Which group.** `/desk_here` refuses a public group, and a group with anyone besides you and the bot. Anyone in the group could read your mirrored chat and permission previews. Claude Code masks recognisable secrets in those previews, but not all of them.
- **The mirror token.** Every `teledesk code` spawn mints a fresh 128-bit secret and passes it to the session's environment (`TELEDESK_MIRROR`) and nothing else: never written to disk, never logged. Whoever holds that token for a live session can post mirror lines into its topic — that is its whole power. The channel passes it to the daemon over the local socket, which it only connects to when the socket is owned by your user (an `lstat` uid check); the daemon binds each token to one session row and one Claude Code session id. The mirror is **one-way**: mirror lines can't answer permission prompts (that stays a separate, gated verdict path) and can't inject anything into the session — nothing written to the socket turns into model input. The phone-visible surface still needs all of: a launcher-spawned session (`TELEDESK=1`), an explicit `/desk`, and the solo-group privacy check above.
- **What's sent as text.** Prompt descriptions and previews are shown as plain text on labelled lines, with direction overrides and invisible characters removed. Nothing is sent with Telegram formatting, and mirrored text can't start the way a permission prompt does.
- **Nothing hidden.** A prompt is shown in full or not at all. Claude Code itself shortens fields longer than 3,500 characters before relaying them, marking the gap with "⋯ N code points elided ⋯". A prompt with that mark isn't whole either, so it's terminal-only too.
- **Mirrored text is marked and scrubbed.** Every mirrored answer part starts with 🤖 and every mirrored prompt with 🧑; direction overrides and invisible characters are stripped from anything the transcript put there. Mirrored text can't get buttons, and it can't pass for a prompt or a status line.
- **Limits.** One local program or one runaway session can't flood the bot. At most 20 live sessions, 10 session starts and 5 new topics a minute; sessions over a limit get their topic as soon as there's room. Each session gets at most 20 messages a minute, and more wait their turn; mirrored chat has its own 60-sends-a-minute budget per session — over it, tool bubbles are skipped and chat still lands. There are also bounded queues and line sizes, and a timeout for half-sent lines. Each limit logs once a minute when it's hit.
- **Who's in the group.** If anyone besides you and the bot shows up in the desk group (a message from them, or someone joining), desk turns itself off there until you send `/desk_here` again.
- **Late messages.** A message dated before a session started isn't passed to it; it was meant for an earlier session in that folder.
- **Claude Code version.** Use Claude Code 2.1.234 or newer: older versions don't clean or mask what they relay. `teledesk code` warns if yours is older.
- **The socket.** It lives at `$XDG_DATA_HOME/teledesk/desk.sock` (default `~/.local/share/teledesk/`). The folder is 0700 and the socket 0600. The daemon won't listen in a folder others can write to, and the channel server only connects to a socket owned by your user. `TELEDESK_DATA_DIR` overrides the folder. Use the same value for the daemon and your shell.
- **When the channel runs.** The channel server only runs when `TELEDESK=1` is set, which `teledesk code` sets for interactive sessions only. So it stays out of `claude -p` jobs and out of any session that merely has it configured.
- **Network.** The daemon makes outbound connections to Telegram only. It opens no inbound ports.

## Troubleshooting

- **"WARNING: Loading development channels" at every start** — expected: it's the research-preview cost of a custom channel, and there is no way to pre-approve it. Pick *I am using this for local development*. It appears once per launch, not per `/desk`.
- **`/desk` isn't a command** — `teledesk install` writes `~/.claude/commands/desk.md`; run it, or just tell the session "call the desk_on tool".
- **`/desk` says no desk_on tool** — that session wasn't started through the wrapper, so the channel never loaded. Shells (and tmux panes) that were already open when you ran `teledesk install` haven't read the new function yet: run `source ~/.bashrc` there first, or start sessions with `teledesk code` explicitly. The durable fix is `teledesk install --shim`, which puts the wrapper on `PATH` so those shells and spawn paths get it without reading any rc file. The tell: a wrapped session shows the "WARNING: Loading development channels" dialog once at startup; no dialog, no desk.
- **A session says the daemon isn't reachable** — the daemon isn't running (`npm start` or the systemd unit). The session keeps retrying in the background and its topic opens when the daemon comes back; nothing is lost.
- **The phone is silent for a session you're working in** — three checks. Is the desk on? Sessions start dormant and `/desk off` silences them: send `/desk` again. Is the daemon running? Mirrored lines post only while it is. And was the session relaunched? The mirror token is minted **per spawn** and lives only in that session's launching environment — a relaunch needs a fresh `/desk`, and a `claude` started outside the wrapper (no `TELEDESK_MIRROR` in its env, e.g. from an IDE or a plain `sh -c` before the shim was on PATH) mirrors nothing.
- **Nothing works right after upgrading** — restart `teledesk.service` after upgrading — an old daemon's strict hello schema rejects the new `mirror_token` field, and the hello skew breaks attach until the daemon is current (running sessions survive the restart via the existing 90 s reconnect grace). Sessions keep the old channel until relaunched; a pre-upgrade channel's stale `reply` lines are answered with a protocol error and change nothing else.
- **The bot never reacts in the group** — only one program may poll a bot token; a second poller makes Telegram answer 409, which the daemon logs. Also check the sender: only `TELEGRAM_ALLOWED_USER_ID` counts, and messages posted "as the group" are ignored.
- **"Desk is off: … someone else …"** — a human besides you posted in (or joined) the desk group, so the bot stopped using it. Remove them and send `/desk_here` again. The bot's own messages are echoes and never trigger this.
- **Messages into the void in a same-named group** — if you write in a group that isn't the desk group, the bot DMs you once with its id. Send `/desk_here` there to make it the desk group (this works from any group; the latest wins).
- **`/desk` reports a reason instead of a topic** — the tool result carries the daemon's exact complaint (no desk group, too many sessions/topics right now, group not private…). Fix what it says and run `/desk` again.

## Development

```
npm test            # vitest: router, mirror cycle, channel server, protocol, hooks, installer, poller, daemon (fake Telegram, real sockets)
npm run typecheck   # tsc, including legacy/
npm run smoke       # spawns `bin/teledesk desk-channel` over real stdio against a real router: wiretap surface, a mirrored prompt/answer, a tapped verdict
```

```
src/
├── index.ts          daemon entry: .env, signals
├── daemon.ts         one bot, one router; direct-message help
├── poll.ts           getUpdates loop; sorts updates for the router
├── cli.ts            bin/teledesk: code | install | uninstall | desk-channel
├── paths.ts          data folder (incl. the one-time move from the pre-rename folder), socket, database, MCP config
└── desk/
    ├── router.ts     topics, owner gating, relaying, the mirror (token gate, batch machine, echo dedupe), permission prompts, /desk_here, the stale-topic sweep
    ├── channel.ts    the per-session stdio channel server: dormant until desk_on, then the socket link — inbound messages and prompts only, no outbound text tool
    ├── mirror-hook.ts the hook entrypoint: Claude Code hook JSON in, mirror protocol lines out; exit 0 whatever happens
    ├── protocol.ts   socket messages (zod, JSON lines, size limits); there is no model-facing send variant
    ├── launcher.ts   `code`: MCP config, claude flags, interactive-only check, the per-spawn mirror token
    ├── install.ts    the shell hook, the /desk command file, and the four guarded mirror hooks
    ├── bot-api.ts    the Bot API calls the router makes
    ├── state.ts      desk sessions and the group id (node:sqlite)
    └── types.ts      the interfaces the router depends on
```

## Other folders

`signal-brief/`, `hk-events/` and `job-sift/` are separate tools that live in this repo; each has its own README. The first version of this bot (a `claude -p` / tmux bridge) is retired and kept in [`legacy/`](legacy/README.md).

## License

MIT.
