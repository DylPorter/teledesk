# claude-telegram

**Your Claude Code sessions in Telegram topics.** Start Claude Code with `claude-telegram code` and that session gets its own topic in a private Telegram group. To talk to it from your phone, write in the topic. Its replies come back in the topic, and its permission prompts show up there with **Allow** and **Deny** buttons. No commands to learn: each topic is one session, like a chat list.

```
your terminal                          your phone
claude-telegram code  ──┐
  (Claude Code + channel │  unix socket   ┌──────────────┐   Telegram   ┌──────────────────────┐
   server, one per       ├──────────────▶ │ claude-      │ ◀──────────▶ │ group with Topics:   │
   session)              │                │ telegram     │   one bot    │  • api · main        │
claude-telegram code  ──┘                 │ daemon       │              │  • web · fix-login   │
                                          └──────────────┘              └──────────────────────┘
```

It uses Claude Code [channels](https://code.claude.com/docs/en/channels-reference). Each session loads a small stdio MCP server (`claude-telegram desk-channel`), which connects to the daemon over a local socket. The daemon owns the bot, creates and reuses the topics, and relays messages, replies and permission prompts. It never types into your terminal and never scrapes the screen.

> **Research preview.** Channels are a Claude Code research preview, and custom channels aren't on its allowlist. So `claude-telegram code` loads this one with `--dangerously-load-development-channels`. Claude Code then shows **"WARNING: Loading development channels"** at every start, and you confirm with *I am using this for local development*. Channels only work in interactive sessions (not `-p`, not the Agent SDK). The protocol may change.

## Setup

1. **Make a bot.** Create a new bot with [@BotFather](https://t.me/BotFather). Give it to this program alone: only one program can poll a bot token.
2. **Configure.** `npm install`, then create `.env` in the repo folder:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_ALLOWED_USER_ID=<your numeric Telegram user id; @userinfobot tells you>
   ```
   Then `chmod 600 .env`: it holds the bot token.
3. **Start the daemon.** Run `npm start`, or install `systemd/claude-telegram.service` as a user unit (set its `WorkingDirectory` to your clone).
4. **Make the desk group** in Telegram:
   - Create a group with **just you and the bot**, and turn on **Topics** in its settings.
   - Make the bot an **admin** with the **Manage topics** right. Being an admin also lets it see ordinary messages.
   - Don't post as the group ("Remain anonymous"); those messages are ignored.
   - Send **`/desk_here`** in the group. The bot either confirms or tells you what's missing. `/desk_off` turns it off again.
5. **Start sessions.** Put `bin/` on your PATH (or symlink `bin/claude-telegram`), then run `claude-telegram code` in any folder, with any `claude` arguments after it.
   - A topic named `<folder> · <branch>` appears.
   - A second session in the same folder gets `#2`.
   - The same folder later gets its topic back.
   - Optional: `alias claude='claude-telegram code'`. Non-interactive runs (`-p`, `--output-format`, `--version`, `mcp …`, `update` and the other subcommands) are passed straight to plain `claude` without the channel.

Message the bot directly for a short help text and the list of live sessions.

## What happens where

| You do | What happens |
|---|---|
| Write in a session's topic | It reaches that session only, as `<channel source="claude-telegram" message_id="…">` |
| Claude calls the `reply` tool | The text appears in the topic, split into parts if it's long. The tool is pre-allowed, so no prompt for it |
| Claude wants to run a tool that needs approval | The prompt appears in the topic: the tool, what it does, and its input, field by field (nested fields too). Every field shows its start and its end; only a long field's middle is hidden, so no field's ending is ever cut off. A prompt that can't be shown that way (too large, too many fields, or input that isn't a set of fields and is too long to show whole) says so and can only be answered in the terminal. The terminal dialog stays open too, and whichever answer comes first wins |
| Tap Allow / Deny, or type `yes abcde` / `no abcde` | The answer goes to that session. Tapping a second time does nothing |
| Close the session | The topic says "Session ended" and closes |
| Restart the daemon | Sessions reconnect by themselves and keep their topics |

## Security model

- **Who can drive a session.** Only messages whose sender is `TELEGRAM_ALLOWED_USER_ID` reach a session. The check is on the sender's user id, not the chat id.
- **What's never passed on.** Forwarded messages, messages sent through an inline bot, posts made as the group or a channel, messages from bots, and edits are never passed to a session. Treat whoever controls your Telegram account as someone who can drive your Claude Code sessions.
- **When an answer counts.** A permission answer from Telegram is accepted only for a prompt that session raised and that was shown in full in its topic. A tap also has to come from that very message.
  - If a prompt couldn't be shown, Telegram says to answer in the terminal, and nothing typed or tapped in Telegram can answer it.
  - After a daemon restart, old buttons stop working.
  - The channel server also drops any answer for a request its own session didn't make.
- **Which group.** `/desk_here` refuses a public group, and a group with anyone besides you and the bot. Anyone in the group could read your replies and permission previews. Claude Code masks recognisable secrets in those previews, but not all of them.
- **What's sent as text.** Prompt descriptions and previews are shown as plain text on labelled lines, with direction overrides and invisible characters removed. Nothing is sent with Telegram formatting, and a reply from Claude can't start the way a permission prompt does.
- **Hidden middles.** A long field's middle is hidden in Telegram (its first and last ~600 characters show). Read the terminal for anything you need to see in full. Claude Code itself already shortens very long fields the same way before relaying them.
- **Who's in the group.** If anyone besides you and the bot shows up in the desk group (a message from them, or someone joining), desk turns itself off there until you send `/desk_here` again.
- **Late messages.** A message dated before a session started isn't passed to it; it was meant for an earlier session in that folder.
- **Claude Code version.** Use Claude Code 2.1.234 or newer: older versions don't clean or mask what they relay. `claude-telegram code` warns if yours is older.
- **The socket.** It lives at `$XDG_DATA_HOME/claude-telegram/desk.sock` (default `~/.local/share/claude-telegram/`). The folder is 0700 and the socket 0600. The daemon won't listen in a folder others can write to, and the channel server only connects to a socket owned by your user. `CLAUDE_TELEGRAM_DATA_DIR` overrides the folder. Use the same value for the daemon and your shell.
- **When the channel runs.** The channel server only runs when `CLAUDE_TELEGRAM_DESK=1` is set, which `claude-telegram code` sets for interactive sessions only. So it stays out of `claude -p` jobs and out of any session that merely has it configured.
- **Network.** The daemon makes outbound connections to Telegram only. It opens no inbound ports.

## Development

```
npm test            # vitest: router, channel server, protocol, poller, daemon (fake Telegram, real sockets)
npm run typecheck   # tsc, including legacy/
npm run smoke       # spawns `bin/claude-telegram desk-channel` over real stdio against a real router
```

```
src/
├── index.ts          daemon entry: .env, signals
├── daemon.ts         one bot, one router; direct-message help
├── poll.ts           getUpdates loop; sorts updates for the router
├── cli.ts            bin/claude-telegram: code | desk-channel
├── paths.ts          data folder, socket, database, MCP config
└── desk/
    ├── router.ts     topics, owner gating, relaying, permission prompts, /desk_here
    ├── channel.ts    the per-session stdio channel server and its socket link
    ├── protocol.ts   socket messages (zod, JSON lines, size limits)
    ├── launcher.ts   `code`: MCP config, claude flags, interactive-only check
    ├── bot-api.ts    the Bot API calls the router makes
    ├── state.ts      desk sessions and the group id (node:sqlite)
    └── types.ts      the interfaces the router depends on
```

## Other folders

`signal-brief/`, `hk-events/` and `job-sift/` are separate tools that live in this repo; each has its own README. The first version of this bot (a `claude -p` / tmux bridge) is retired and kept in [`legacy/`](legacy/README.md).

## License

MIT.
