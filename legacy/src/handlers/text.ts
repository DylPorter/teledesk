import type { Context } from "grammy";
import { streamClaude, type StreamOptions } from "../lib/claude.js";
import { getSession, updateSession } from "../lib/session.js";
import { deregister, getRunning, register } from "../lib/running.js";

type OverrideOpts = Pick<StreamOptions, "model" | "effort"> & {
  /** Override the chat's working dir for this one turn only. */
  cwd?: string;
  /** If true: don't resume the chat's session and don't persist the new id. */
  ephemeral?: boolean;
  /** Called with the id of every message that carries answer text. */
  onSent?: (messageId: number) => void;
};

const TELEGRAM_LIMIT = 4000;
const THINKING_PLACEHOLDER = "💭 _thinking…_";

/**
 * Send a Telegram message safely; falls back to plain text if Markdown parses fail.
 * Returns the new message_id, or null if both attempts fail.
 */
export async function safeReply(
  ctx: Context,
  text: string,
  opts?: { markdown?: boolean },
): Promise<number | null> {
  try {
    const msg = await ctx.reply(text, {
      parse_mode: opts?.markdown ? "Markdown" : undefined,
    });
    return msg.message_id;
  } catch {
    try {
      const msg = await ctx.reply(text);
      return msg.message_id;
    } catch {
      return null;
    }
  }
}

async function safeEdit(
  ctx: Context,
  messageId: number,
  text: string,
  opts?: { markdown?: boolean },
): Promise<boolean> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      parse_mode: opts?.markdown ? "Markdown" : undefined,
    });
    return true;
  } catch {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
      return true;
    } catch {
      return false;
    }
  }
}

/** Split long text on paragraph/line boundaries close to the Telegram limit. */
export function chunk(text: string, size = TELEGRAM_LIMIT): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let split = remaining.lastIndexOf("\n", size);
    if (split < size / 2) split = size;
    parts.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Placeholder-per-cycle text streaming.
 *
 * Lifecycle for one user turn:
 *   1. Send "💭 thinking…" placeholder when the user message arrives.
 *   2. When an assistant text block arrives, edit the current placeholder
 *      to that text *exactly once* and clear our reference to it.
 *   3. When a tool_result arrives (signalling Claude is about to think again),
 *      send a fresh "💭 thinking…" placeholder for the next cycle.
 *   4. On `done`, if a placeholder is still pending we either replace it with
 *      the final result text (if it's new) or delete it (no content arrived).
 *
 * This means each Telegram message gets at most one edit — no rolling edits,
 * no overwrite races, no duplicated content. Completion is visually obvious:
 * the last message in the chat is a real answer, not "thinking…".
 */
export async function handleText(
  ctx: Context,
  _text: string,
  override: OverrideOpts = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // A new turn supersedes whatever's already running for this chat: kill it,
  // then take over. (Sending /stop instead halts without starting anything.)
  const prev = getRunning(chatId);
  if (prev) {
    prev.abort();
    deregister(chatId, prev.pid);
  }

  const controller = new AbortController();
  let myPid: number | null = null;

  await ctx.replyWithChatAction("typing");
  const session = await getSession(chatId);
  const effectiveCwd = override.cwd ?? session.cwd;
  const effectiveResume = override.ephemeral ? null : session.sessionId;

  const placeholder = override.model
    ? `🧠 _${override.model}/${override.effort ?? "default"}${override.cwd ? ` in ${override.cwd}` : ""}…_`
    : THINKING_PLACEHOLDER;
  let pendingMsgId: number | null = await safeReply(ctx, placeholder, {
    markdown: true,
  });
  const sentTexts: string[] = [];

  /**
   * Render `text` into the chat: edit the pending placeholder with the first
   * chunk; any overflow chunks go out as new messages. After this, the
   * placeholder reference is cleared — the next cycle gets a fresh one.
   */
  const renderAssistantText = async (text: string): Promise<void> => {
    const clean = text.trim();
    if (!clean) return;
    sentTexts.push(clean);
    const parts = chunk(clean);
    const sent = (id: number | null) => {
      if (id !== null) override.onSent?.(id);
    };

    if (pendingMsgId !== null && (await safeEdit(ctx, pendingMsgId, parts[0], { markdown: true }))) {
      sent(pendingMsgId);
    } else {
      sent(await safeReply(ctx, parts[0], { markdown: true }));
    }
    pendingMsgId = null;

    for (const p of parts.slice(1)) {
      sent(await safeReply(ctx, p, { markdown: true }));
    }
  };

  /** Send a new placeholder if we don't already have one outstanding. */
  const ensurePlaceholder = async (): Promise<void> => {
    if (pendingMsgId !== null) return;
    pendingMsgId = await safeReply(ctx, placeholder, { markdown: true });
  };

  /** Drop a leftover placeholder that never got filled. */
  const clearPlaceholder = async (): Promise<void> => {
    if (pendingMsgId === null) return;
    try {
      await ctx.api.deleteMessage(chatId, pendingMsgId);
    } catch {
      // best-effort — old messages may be undeletable
    }
    pendingMsgId = null;
  };

  try {
    let finalText = "";
    let finalSessionId: string | null = null;
    let hadError = false;

    for await (const ev of streamClaude({
      message: _text,
      cwd: effectiveCwd,
      resumeSessionId: effectiveResume,
      model: override.model,
      effort: override.effort,
      signal: controller.signal,
      onSpawn: (pid) => {
        myPid = pid;
        register({
          chatId,
          pid,
          startedAt: Date.now(),
          abort: () => controller.abort(),
          label: _text.slice(0, 60),
        });
      },
    })) {
      if (ev.kind === "assistant_text") {
        await renderAssistantText(ev.text);
      } else if (ev.kind === "tool_result") {
        // Tool finished; Claude is about to think/respond again.
        await ensurePlaceholder();
      } else if (ev.kind === "done") {
        finalText = ev.text || "";
        finalSessionId = ev.sessionId;
        if (ev.isError) hadError = true;
      } else if (ev.kind === "error") {
        await clearPlaceholder();
        await safeReply(ctx, `⚠️ ${ev.error}`);
        hadError = true;
      }
      // tool_use and system events are intentionally silent.
    }

    // If `done` carried text that hasn't been surfaced yet, render it now.
    const lastSent = sentTexts[sentTexts.length - 1] ?? "";
    if (finalText.trim() && finalText.trim() !== lastSent) {
      await renderAssistantText(finalText);
    } else {
      await clearPlaceholder();
    }

    if (finalSessionId && !hadError && !override.ephemeral) {
      await updateSession(chatId, { sessionId: finalSessionId });
    }
  } catch (err) {
    await clearPlaceholder();
    await safeReply(ctx, `⚠️ Error: ${(err as Error).message}`);
  } finally {
    if (myPid !== null) deregister(chatId, myPid);
  }
}
