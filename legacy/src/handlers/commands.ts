import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Context } from "grammy";
import { env } from "../lib/env.js";
import { getSession, resetSession, updateSession } from "../lib/session.js";
import { stopChat } from "../lib/running.js";
import { bridgeStatusLine, stopBridged } from "./bridge.js";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "👋 Claude here.\n\n" +
      "Send me anything — ideas, questions, instructions to manage your vault.\n\n" +
      "Commands:\n" +
      "• /stop — interrupt the current run (or just send a new message to redirect)\n" +
      "• /reset — start a new conversation\n" +
      "• /status — show current session + working dir\n" +
      "• /cd <path> — change working directory\n" +
      "• /vault — switch to vault dir\n" +
      "• /deep <prompt> — one turn at opus + high effort\n" +
      "• /run <abs-path> [low|med|high] <prompt> — one-off in another dir (opus, fresh session)\n\n" +
      "Live sessions (Claude open in tmux):\n" +
      "• /sessions — list them, with pin buttons\n" +
      "• /to <n> — pin a session; everything goes there\n" +
      "• /unpin — back to auto-routing\n" +
      "• /new [text] — fresh claude -p session instead (pinned)\n" +
      "• Reply to a session's message to answer that session\n",
  );
}

export async function handleReset(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await resetSession(chatId);
  await ctx.reply("🔄 Fresh conversation. What's up?");
}

export async function handleStop(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const job = stopChat(chatId);
  if (!job) {
    const panes = await stopBridged(chatId);
    await ctx.reply(
      panes.length
        ? `⏹️ Sent Esc to: ${panes.join(", ")}.\nAnything already done is NOT undone.`
        : "Nothing running.",
    );
    return;
  }
  const secs = Math.round((Date.now() - job.startedAt) / 1000);
  await ctx.reply(
    `⏹️ Stopped — was running ${secs}s.\n` +
      "Heads up: anything it already did (file writes, API calls, n8n changes) is NOT undone.\n" +
      "Send a new message to redirect, or carry on.",
  );
}

export async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const s = await getSession(chatId);
  await ctx.reply(
    `**Current state**\n` +
      `• Working dir: \`${s.cwd}\`\n` +
      `• Session: \`${s.sessionId ?? "(new)"}\`\n` +
      `• Updated: ${s.updatedAt}\n` +
      bridgeStatusLine(s.pin?.kind === "pane" ? s.pin.label : s.pin?.kind === "bot" ? "bot session" : null),
    { parse_mode: "Markdown" },
  );
}

export async function handleCd(ctx: Context, rawPath: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const resolved = expandTilde(rawPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    await ctx.reply(`⚠️ \`${resolved}\` doesn't exist or isn't a directory.`, { parse_mode: "Markdown" });
    return;
  }
  await updateSession(chatId, { cwd: resolved, sessionId: null });
  await ctx.reply(`📂 Now in \`${resolved}\` (new session)`, { parse_mode: "Markdown" });
}

export async function handleVault(ctx: Context): Promise<void> {
  await handleCd(ctx, env.DEFAULT_CWD);
}
