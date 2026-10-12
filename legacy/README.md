# claude-telegram (legacy)

> **Retired.** This is the first version of claude-telegram: a `claude -p` / tmux bridge bot. It was replaced by desk sessions in Telegram topics (see the [main README](../README.md)) and is kept here for reference. Its code is in `legacy/src`, its tests in `legacy/tests` (`npm run test:legacy`), its unit in `legacy/systemd`. Paths below that start with `src/`, `tests/` or `scripts/` now live under `legacy/`; run it from the repo root with `npx tsx legacy/src/index.ts`.

Chat with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone via Telegram. Uses your **Max plan** auth — no API key, no per-token costs.

I built this because the most useful AI assistant in my life lives in my terminal on my laptop, and I'm not always at my laptop. Bridging it to Telegram (running locally as a systemd service) gives me a "second brain in my pocket" without paying API rates on top of the Max subscription I already have.

```
Telegram (phone)
    ↓
Linux box runs the bot (systemd service)
    ↓
Bot spawns `claude -p --resume <id>` per message
    ↓
Claude Code with full tools, your memory, your CLAUDE.md
    ↓
Responses streamed back as Telegram messages
```

## Features

- **Real Claude Code, not an API wrapper.** Your `~/.claude/CLAUDE.md`, your memory, your MCP servers, your skills — all of it works exactly like it does on the desktop.
- **Per-cycle streaming UX.** Each Claude "thinking cycle" sends a `💭 thinking…` placeholder that gets edited *once* into its actual text. When you stop seeing `thinking…` messages, you know it's finished. No rolling edits, no overwrite races, no duplicated content.
- **Tunable model + effort** per env var or per message. Default is `sonnet` + `low` effort (snappy capture from the phone); `/deep` upgrades a single turn to `opus + high` for harder work; `/run` lets you point one turn at a different working directory entirely.
- **Voice notes** are saved to disk; for *dictating to* the bot, use your phone's native voice-to-text (faster than rolling your own transcription).
- **Photos and files** (single or an album) save to your attachments directory and reach Claude as one prompt listing every file. Put the instruction in the caption; uploads sent without a caption are attached to your next text message (within 10 minutes).
- **Auth-gated to a single Telegram user ID.** The bot ignores everyone else.

## Why not just use the Claude app on mobile?

Different shape of problem. The Claude mobile app is for chatting with Claude. This bot is for instructing Claude *Code* — your actual tools, your actual filesystem, your actual workflows. It can edit files on your laptop, run commands, hit your MCP servers. The Claude mobile app can't do any of that.

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. `/newbot` → pick a name and handle.
3. Save the bot token.

### 2. Get your Telegram user ID

1. Message [@userinfobot](https://t.me/userinfobot).
2. Note your numeric ID.

### 3. Install

```bash
git clone https://github.com/DylPorter/claude-telegram.git ~/Documents/Programming/claude-telegram
cd ~/Documents/Programming/claude-telegram
npm install
```

### 4. Configure

```bash
cp .env.example .env
$EDITOR .env   # paste your bot token and user ID
```

Make sure Claude Code is already installed and authenticated on this machine (`claude auth login`). The bot inherits your existing Max-plan login.

### 5. Try it (dev)

```bash
npm run dev
```

Send your bot a message from Telegram. You should see a `💭 thinking…` reply within a few seconds, edited to the actual response shortly after.

### 6. Run as a service

```bash
mkdir -p ~/.config/systemd/user
cp systemd/claude-telegram.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-telegram.service
systemctl --user status claude-telegram.service
```

Logs:

```bash
journalctl --user -u claude-telegram.service -f
```

## Slash commands

| Command | What it does |
|---|---|
| `/start` | Greeting + command list |
| `/reset` | Start a fresh Claude session (clears resume id) |
| `/status` | Show current session id + working dir |
| `/cd <abs-path>` | Switch the chat's working dir (starts a fresh session there) |
| `/vault` | Switch to your default working dir (the `DEFAULT_CWD` env value) |
| `/deep <prompt>` | Run *this turn only* at `opus + high` effort. Same chat session continues. |
| `/run <abs-path> [low\|med\|high\|xhigh\|max] <prompt>` | One-off: opus + chosen effort, in a different cwd, fresh ephemeral session. Doesn't touch your main chat state. |

Anything that isn't a slash command is processed as a regular message.

### Live sessions (tmux bridge)

| Command | What it does |
|---|---|
| `/sessions` | List Claude Code sessions open in tmux panes (🟢 idle · ⏳ busy · ⏸ prompt open), with pin buttons |
| `/to <n>` | Pin session *n*: every message goes there until `/unpin` |
| `/unpin` | Back to auto-routing |
| `/new [text]` | Fresh `claude -p` conversation instead (the pre-bridge behaviour), pinned until `/unpin` |
| *reply to a message* | Replying to a session's message sends your reply to that session |

## Live-session bridge

If you keep interactive `claude` sessions open in tmux, the bot talks to *those* instead of starting new ones.

The rule is **one process owns each session**. Running `claude -p --resume <id>` on a session that's still open in a terminal forks it into two histories that diverge. So the bot never does that. It types your message into the pane (`tmux send-keys -l`, then Enter), exactly as if you were at the keyboard, and reads the reply back from the session transcript. The terminal and the phone are two windows onto the same conversation.

- **Discovery.** tmux pane → pane process tree → `claude` PID → Claude Code's per-process status file (`~/.claude/sessions/<pid>.json`: session id, cwd, idle/busy/waiting) → transcript (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). Titles and recent prompts come from the transcript's head and tail. These files are undocumented; the parsing is tolerant, but a Claude Code update can change them.
- **Routing is sticky.** A message with no pin goes to the session you're already talking to. Order of precedence:
  1. A Telegram reply to an answer goes back to that answer's session.
  2. A pin.
  3. The current session. Short follow-ups (under 40 characters) go straight there with no router call. Longer messages ask a small tool-less `claude -p --model haiku` classifier, and only switch (with a "↪ Switched to …" notice) when it is at least 85% sure the message belongs to a *different* session.
  4. After 6 hours of silence, or if the pane has closed, plain routing: a confident pick goes through, otherwise you get buttons for the top 3 sessions plus "New session". With no live panes, the bot uses `claude -p` as before.

  The current session is stored in the state file, so it survives restarts.
- **Safety gates.** Nothing is typed unless the pane's foreground command is `claude`, the session is idle (status file *and* no spinner on screen), no prompt is open, and the prompt box is empty. It never appends to a draft you left there. Otherwise the message waits in a per-pane queue, up to 2h, and is sent in order.
- **Replies.** The bot tails the transcript from the byte offset it recorded before sending. It relays the turn's text blocks and hides tool calls, the same as the `claude -p` path. It stops at the turn-end marker.
- **Permission prompts.** If the session stops at an approval prompt mid-turn, the prompt comes to Telegram with one button per option. A button presses that option's number key, but only after re-checking that the same prompt is still open.
- **`/stop`** on a bridged turn sends Esc (Claude Code's interrupt) to the pane.

Test it without touching your real panes: `npx tsx scripts/smoke-bridge.ts` runs everything against a throwaway `claude --model haiku` on an isolated `tmux -L bridgetest` server. It checks for forks at the end (exactly one transcript and one owning process).

## Configuration

All env vars live in `.env`:

| Var | Purpose | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather | _(required)_ |
| `TELEGRAM_ALLOWED_USER_ID` | The only user allowed to talk to the bot | _(required)_ |
| `CLAUDE_BIN` | Path to the `claude` binary | `claude` |
| `DEFAULT_CWD` | Working dir for new chats and `/vault` | _(required)_ |
| `STATE_DIR` | Where per-chat session state is stored | _(required)_ |
| `CLAUDE_MODEL` | `sonnet`, `haiku`, `opus`, or a full model id | `sonnet` |
| `CLAUDE_EFFORT` | Thinking budget: `low`, `medium`, `high`, `xhigh`, `max` | `low` |
| `PUSH_PORT` / `PUSH_SECRET` | Localhost `/push` server for scheduled briefs | `7421` / _(required)_ |
| `PUSH_DOCUMENTS` | Allowlist for `/push-document`: `key=/abs/path,…` | _(unset — endpoint disabled)_ |
| `TMUX_BRIDGE_ENABLED` | Route messages into live tmux Claude sessions | `true` |
| `TMUX_BIN` / `TMUX_SOCKET` | tmux binary / optional `-L` socket name | `tmux` / _(default server)_ |
| `ROUTER_MODEL` | Model for the session router | `haiku` |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (`sessions/`, `projects/`) | `~/.claude` |

To bump the default model permanently, edit `.env` and `systemctl --user restart claude-telegram`.

## Design notes

**Placeholder-per-cycle output.** Per user turn, the bot sends one `💭 thinking…` message. When Claude emits text, that message gets edited *exactly once* to the text. If Claude then uses a tool and responds again, a *new* `💭 thinking…` message is sent for the next cycle. Each Telegram message is therefore edited at most once. This is deliberately different from "stream tokens into one rolling message" — that pattern hits Telegram's edit-throttle, fights with chunk boundaries, and has a nasty failure mode where edits overwrite earlier content. The per-cycle pattern also gives you a free "I'm done" signal: when the last message in the chat is real content (not `thinking…`), the turn is finished.

**Tool activity is silent.** The old version of this bot rendered `🔧 Tool …` / `✓ result` chatter for every tool call. Nice for debugging, ugly for daily use. Now: tools run, you see the output cycle that follows. If you want the trace, `journalctl` it.

**Cold-spawn architecture.** Today, every message spawns `claude -p --resume <session-id>` as a fresh subprocess. The CLI cold start is ~3–5s before any token is generated. That's the main source of perceived latency. A future version may migrate to `@anthropic-ai/claude-agent-sdk` so one bot process keeps a Claude session warm in-memory — that should eliminate the bulk of cold-start lag.

## Limitations

- Linux-focused (systemd unit included). Should work fine on macOS via launchd; you'd have to adapt the service file.
- One authorized user per bot instance. Not multi-tenant.
- Telegram message size cap of 4 KB per message — long outputs get split into multiple messages, but tables and code blocks may break across the seam.
- `/run` tokenizer doesn't handle paths with spaces. Don't put spaces in your project paths and you'll be fine.
- No streaming of partial messages within a cycle. Cold-spawn + Telegram edit limits make this not worth doing today.

## Security

- Only the user matching `TELEGRAM_ALLOWED_USER_ID` is allowed to interact. Everyone else is silently ignored.
- Claude runs with `--permission-mode bypassPermissions`. The bot effectively has the same filesystem + shell access as the user running the systemd service. **Don't run this on a machine where that would be unacceptable.**
- The bot makes outbound connections to Telegram only. No inbound ports.
- `.env` contains a long-lived bot token — keep it out of version control (already in `.gitignore`).
- `POST /push-document` sends a file to your chat as a document attachment. A caller names a **key**, never a path: the key → path mapping lives only in `PUSH_DOCUMENTS`, so the endpoint cannot be used to read an arbitrary file even by something that already holds the push secret. `PUSH_DOCUMENTS` unset (the default) disables the endpoint entirely. Only list files you are willing to have delivered to your Telegram account.

## Architecture

```
src/
├── index.ts              Bot entrypoint, command routing, auth gate
├── lib/
│   ├── env.ts            Zod-validated env config
│   ├── claude.ts         Spawns `claude -p` and parses stream-json events
│   ├── session.ts        Per-chat session-id + cwd + pin state, JSON-file backed
│   ├── uploads.ts        Groups album/multi-file uploads into one prompt
│   ├── vault.ts          Saves photo/voice attachments
│   └── bridge/           Live tmux-session bridge
│       ├── discovery.ts  pane → claude PID → session → transcript
│       ├── transcript.ts JSONL tailing, turn tracking, summaries
│       ├── tmux.ts       send-keys argv, capture-pane state (busy/prompt/draft)
│       ├── bridge.ts     gated delivery, per-pane queue, reply tailing
│       ├── router.ts     haiku classifier + tolerant JSON parsing
│       ├── sticky.ts     stay-with-current-session routing decisions
│       └── reply-targets.ts  message id → session for Telegram replies
└── handlers/
    ├── commands.ts       /start, /reset, /status, /cd, /vault, /stop
    ├── bridge.ts         routing, /sessions /to /unpin /new, inline buttons
    ├── text.ts           Placeholder-per-cycle text streaming
    ├── media.ts          Photo + document uploads (albums batched)
    └── voice.ts          Voice-note capture (transcription is gboard's job)
```

## Stack

- [grammY](https://grammy.dev/) for the Telegram bot framework
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI as the brain (via `--output-format stream-json`)
- TypeScript + [tsx](https://github.com/privatenumber/tsx) for the runtime
- systemd for "always on"

## License

MIT.
