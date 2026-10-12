/**
 * Telegram side of the live-session bridge: routing, pinning, prompt buttons.
 *
 * Text with no pinned target is classified onto one of the Claude sessions
 * already open in tmux panes (see lib/bridge). A confident match is sent
 * straight there; otherwise the owner picks from buttons. Replying (Telegram
 * "reply") to a bridged message sends the reply to that same session.
 */

import { homedir } from "node:os";
import path from "node:path";
import { InlineKeyboard, type Context } from "grammy";
import { env } from "../lib/env.js";
import { getSession, resetSession, updateSession } from "../lib/session.js";
import {
  answerPrompt,
  deliver,
  interruptPane,
  queueDepth,
} from "../lib/bridge/bridge.js";
import {
  listLiveSessions,
  sessionLabel,
  type DiscoveryConfig,
  type LiveSession,
} from "../lib/bridge/discovery.js";
import { ReplyTargets } from "../lib/bridge/reply-targets.js";
import { classify } from "../lib/bridge/router.js";
import { planRoute, resolveSticky, type Target } from "../lib/bridge/sticky.js";
import type { PanePrompt } from "../lib/bridge/tmux.js";
import { chunk, handleText, safeReply } from "./text.js";

const ROUTE_MIN_CONFIDENCE = 0.7;

export const bridgeEnabled = env.TMUX_BRIDGE_ENABLED;

const cfg: DiscoveryConfig = {
  tmux: { bin: env.TMUX_BIN, socket: env.TMUX_SOCKET || undefined },
  claudeDir: env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
};

// Bot message id → session, so a Telegram reply goes back to the same session.
const replyTargets = new ReplyTargets();
function rememberReply(messageId: number | null, paneId: string, label: string) {
  replyTargets.remember(messageId, { kind: "pane", paneId, label });
}

/** Record a bot-session answer so a reply to it continues the bot session. */
export function rememberBotReply(messageId: number): void {
  replyTargets.remember(messageId, { kind: "bot" });
}

/** Remember where this chat is talking now, for sticky routing. */
async function markCurrent(chatId: number, target: Target): Promise<void> {
  await updateSession(chatId, { last: target, lastAt: new Date().toISOString() });
}

/** The bot's own `claude -p` session, with its answers recorded for replies. */
async function toBot(ctx: Context, text: string): Promise<void> {
  await markCurrent(ctx.chat!.id, { kind: "bot" });
  return handleText(ctx, text, { onSent: rememberBotReply });
}

/** Send to a target, using the live label for panes. */
function goTo(ctx: Context, target: Target, sessions: LiveSession[], text: string): Promise<void> {
  if (target.kind === "bot") return toBot(ctx, text);
  const live = sessions.find((s) => s.paneId === target.paneId);
  return sendToPane(ctx, target.paneId, live ? sessionLabel(live) : target.label, text);
}

// Messages waiting for the owner to pick a session from buttons.
const pendingRoutes = new Map<string, string>();
let routeSeq = 0;

// In-flight bridged turns per chat, for /stop.
const active = new Map<number, Map<string, { abort: AbortController; label: string }>>();

function statusIcon(s: LiveSession): string {
  if (!s.foregroundClaude) return "🐚";
  switch (s.status) {
    case "idle":
    case "shell":
      return "🟢";
    case "waiting":
      return "⏸";
    case "busy":
      return "⏳";
    default:
      return "❔";
  }
}

function ago(ms: number | null): string {
  if (!ms) return "";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function shortLabel(s: LiveSession, max = 28): string {
  const l = sessionLabel(s);
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}

// ── sending into a pane ──────────────────────────────────────────────────────

async function sendToPane(ctx: Context, paneId: string, label: string, text: string): Promise<void> {
  const chatId = ctx.chat!.id;
  await markCurrent(chatId, { kind: "pane", paneId, label });
  const abort = new AbortController();
  const perChat = active.get(chatId) ?? new Map();
  perChat.set(paneId, { abort, label });
  active.set(chatId, perChat);

  let first = true;
  const say = async (body: string) => {
    for (const part of chunk(first ? `→ ${label}\n\n${body}` : body)) {
      rememberReply(await safeReply(ctx, part, { markdown: true }), paneId, label);
    }
    first = false;
  };

  if (queueDepth(paneId) > 0) {
    await safeReply(ctx, `⏳ Queued behind your previous message to ${label}.`);
  } else {
    await ctx.replyWithChatAction("typing").catch(() => {});
  }
  try {
    await deliver(
      cfg,
      paneId,
      text,
      {
        onText: say,
        onNotice: async (n) => {
          rememberReply(await safeReply(ctx, `${n}\n(${label})`), paneId, label);
        },
        onPrompt: (p) => forwardPrompt(ctx, paneId, label, p),
      },
      { signal: abort.signal },
    );
  } catch (e) {
    await safeReply(ctx, `⚠️ Bridge error: ${(e as Error).message}`);
  } finally {
    const m = active.get(chatId);
    if (m?.get(paneId)?.abort === abort) m.delete(paneId);
  }
}

async function forwardPrompt(ctx: Context, paneId: string, label: string, p: PanePrompt) {
  const kb = new InlineKeyboard();
  for (const o of p.options) {
    const text = `${o.key}. ${o.label}`;
    kb.text(text.length > 40 ? text.slice(0, 39) + "…" : text, `pp:${paneId}:${p.hash}:${o.key}`).row();
  }
  const body = `🔐 ${label} is asking:\n\n${p.question.slice(0, 3000)}`;
  await ctx.reply(body, { reply_markup: kb }).catch(() => ctx.reply(body.slice(0, 4000)));
}

// ── routing ──────────────────────────────────────────────────────────────────

/** Entry point for plain text when the bridge is on. */
export async function routeText(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // 1. A Telegram reply to a bridged message goes back to that session.
  const replied = replyTargets.get(ctx.message?.reply_to_message?.message_id);
  if (replied?.kind === "bot") return toBot(ctx, text);
  if (replied) return sendToPane(ctx, replied.paneId, replied.label, text);

  // 2. A pinned target.
  const session = await getSession(chatId);
  if (session.pin?.kind === "bot") return toBot(ctx, text);

  const sessions = await listLiveSessions(cfg);
  const pin = session.pin;
  if (pin?.kind === "pane") {
    const pinned = sessions.find((s) => s.paneId === pin.paneId);
    if (pinned) return sendToPane(ctx, pinned.paneId, sessionLabel(pinned), text);
    await updateSession(chatId, { pin: null });
    await ctx.reply(`📌 Pinned session (${pin.label}) is gone, so I unpinned it. Routing instead.`);
  }

  // 3. Sticky: stay with the session you're talking to. Short follow-ups
  //    skip the router; longer messages switch only on a confident match.
  const plan = planRoute(session.last, session.lastAt ? Date.parse(session.lastAt) : null, text, sessions);
  if (plan.go === "stay") return goTo(ctx, plan.target, sessions, text);

  // 4. Nothing live: the old `claude -p` path.
  if (sessions.length === 0) return toBot(ctx, text);

  // 5. Classify.
  const lastPaneId = session.last?.kind === "pane" ? session.last.paneId : undefined;
  await ctx.replyWithChatAction("typing").catch(() => {});
  const decision = await classify(
    { claudeBin: env.CLAUDE_BIN, model: env.ROUTER_MODEL },
    sessions,
    text,
    sessions.find((s) => s.paneId === lastPaneId)?.n,
  );
  if (plan.go === "classify") {
    const r = resolveSticky(plan.current, decision, sessions);
    if (r.go === "stay") return goTo(ctx, plan.current, sessions, text);
    await ctx.reply(`↪ Switched to ${r.label}. Reply to an older message to go back.`);
    return goTo(ctx, r.to, sessions, text);
  }
  if (decision && decision.confidence >= ROUTE_MIN_CONFIDENCE) {
    if (decision.target === "new") return toBot(ctx, text);
    const s = sessions[decision.target - 1];
    return sendToPane(ctx, s.paneId, sessionLabel(s), text);
  }

  // 6. Unsure: let the owner pick.
  const ranked: LiveSession[] = [];
  const add = (s?: LiveSession) => s && !ranked.includes(s) && ranked.push(s);
  if (decision && decision.target !== "new") add(sessions[decision.target - 1]);
  add(sessions.find((s) => s.paneId === lastPaneId));
  for (const s of [...sessions].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))) add(s);

  const id = String(++routeSeq);
  pendingRoutes.set(id, text);
  if (pendingRoutes.size > 50) pendingRoutes.delete(pendingRoutes.keys().next().value!);
  const kb = new InlineKeyboard();
  for (const s of ranked.slice(0, 3)) kb.text(`${s.n}. ${shortLabel(s)}`, `rt:${id}:${s.paneId}`).row();
  kb.text("🆕 New session", `rt:${id}:new`);
  await ctx.reply(
    decision ? "Not sure which session this is for:" : "Router didn't answer. Which session?",
    { reply_markup: kb },
  );
}

// ── commands ─────────────────────────────────────────────────────────────────

export async function handleSessions(ctx: Context): Promise<void> {
  if (!bridgeEnabled) {
    await ctx.reply("The tmux bridge is off (TMUX_BRIDGE_ENABLED=false).");
    return;
  }
  const sessions = await listLiveSessions(cfg);
  if (!sessions.length) {
    await ctx.reply("No live Claude sessions in tmux. Messages go to a fresh `claude -p` session.");
    return;
  }
  const s0 = await getSession(ctx.chat!.id);
  const pinnedPane = s0.pin?.kind === "pane" ? s0.pin.paneId : null;
  const lines = sessions.map((s) => {
    const recent = s.summary.recentPrompts.at(-1) ?? s.summary.firstPrompt ?? "";
    return (
      `${s.n}. ${statusIcon(s)} ${sessionLabel(s)}${s.paneId === pinnedPane ? " 📌" : ""}\n` +
      `    ${s.paneTarget} · ${ago(s.lastActivity)}` +
      (recent ? `\n    “${recent.slice(0, 90)}”` : "")
    );
  });
  const kb = new InlineKeyboard();
  sessions.forEach((s, i) => {
    kb.text(`📌 ${s.n}`, `pin:${s.paneId}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row().text("🆕 Bot session", "pin:bot").text("Unpin", "pin:none");
  const body =
    `Live sessions (${s0.pin ? "pinned" : "routing"}):\n\n${lines.join("\n\n")}\n\n` +
    "🟢 idle · ⏳ busy · ⏸ prompt open · 🐚 not at claude prompt";
  for (const [i, part] of chunk(body).entries()) {
    await ctx.reply(part, i === 0 && chunk(body).length === 1 ? { reply_markup: kb } : {});
  }
  if (chunk(body).length > 1) await ctx.reply("Pin one:", { reply_markup: kb });
}

async function pinPane(ctx: Context, s: LiveSession): Promise<void> {
  const label = sessionLabel(s);
  await updateSession(ctx.chat!.id, { pin: { kind: "pane", paneId: s.paneId, label } });
  await ctx.reply(`📌 Pinned to ${s.n}. ${label}\nEverything goes there until /unpin.`);
}

export async function handleTo(ctx: Context, arg: string): Promise<void> {
  if (!bridgeEnabled) {
    await ctx.reply("The tmux bridge is off (TMUX_BRIDGE_ENABLED=false).");
    return;
  }
  const sessions = await listLiveSessions(cfg);
  const n = Number(arg.trim());
  const s = sessions.find((x) => x.n === n || x.paneId === arg.trim());
  if (!s) {
    await ctx.reply(`No session ${arg || "?"}. /sessions lists them.`);
    return;
  }
  await pinPane(ctx, s);
}

export async function handleUnpin(ctx: Context): Promise<void> {
  await updateSession(ctx.chat!.id, { pin: null });
  await ctx.reply(bridgeEnabled ? "Unpinned. Messages are routed to the best-matching session." : "Unpinned.");
}

/** `/new [text]`: fresh `claude -p` conversation, pinned until /unpin. */
export async function handleNew(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat!.id;
  await resetSession(chatId);
  await updateSession(chatId, { pin: { kind: "bot" } });
  if (text) {
    void toBot(ctx, text).catch((e) => console.error("[new]", e));
  } else {
    await ctx.reply("🆕 Fresh bot session (claude -p), pinned. /unpin to go back to routing.");
  }
}

/** /stop for bridged turns: Esc into each busy pane this chat is waiting on. */
export async function stopBridged(chatId: number): Promise<string[]> {
  const m = active.get(chatId);
  if (!m?.size) return [];
  const stopped: string[] = [];
  for (const [paneId, job] of m) {
    job.abort.abort();
    if (await interruptPane(cfg, paneId).catch(() => false)) stopped.push(job.label);
  }
  m.clear();
  return stopped;
}

// ── buttons ──────────────────────────────────────────────────────────────────

export async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (data.startsWith("pin:")) {
    const what = data.slice(4);
    await ctx.answerCallbackQuery();
    if (what === "none") return handleUnpin(ctx);
    if (what === "bot") {
      await updateSession(chatId, { pin: { kind: "bot" } });
      await ctx.reply("📌 Pinned to the bot's own claude -p session. /new to start it fresh, /unpin to route.");
      return;
    }
    const s = (await listLiveSessions(cfg)).find((x) => x.paneId === what);
    if (!s) return void (await ctx.reply("That session is gone."));
    return pinPane(ctx, s);
  }

  if (data.startsWith("rt:")) {
    const [, id, target] = data.split(":");
    const text = pendingRoutes.get(id);
    await ctx.answerCallbackQuery();
    if (text === undefined) return void (await ctx.reply("That message expired. Send it again."));
    pendingRoutes.delete(id);
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (target === "new") {
      void toBot(ctx, text).catch((e) => console.error("[route-new]", e));
      return;
    }
    const s = (await listLiveSessions(cfg)).find((x) => x.paneId === target);
    if (!s) return void (await ctx.reply("That session is gone."));
    void sendToPane(ctx, s.paneId, sessionLabel(s), text).catch((e) => console.error("[route]", e));
    return;
  }

  if (data.startsWith("pp:")) {
    const [, paneId, hash, key] = data.split(":");
    const result = await answerPrompt(cfg, paneId, hash, key).catch((e) => (e as Error).message);
    await ctx.answerCallbackQuery({ text: result === "ok" ? `Pressed ${key}` : result });
    if (result === "ok") {
      const orig = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "";
      await ctx.editMessageText(`${orig}\n\n→ pressed ${key}`).catch(() => {});
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

export function bridgeStatusLine(pinLabel: string | null): string {
  if (!bridgeEnabled) return "• Bridge: off";
  // /status is sent as Markdown; a stray _ or * in a title would break it.
  const safe = pinLabel?.replace(/[_*`[\]]/g, " ");
  return `• Bridge: on · ${safe ? `pinned to ${safe}` : "routing"}`;
}
