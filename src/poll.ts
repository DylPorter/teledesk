/** The bot's one getUpdates loop (Telegram allows one per token), and the sorting of raw
 * updates into group updates for the desk router and direct messages. */
import type { DeskUpdate } from "./desk/types.js";

type RawMessage = Record<string, unknown> & {
  message_id: number; chat: { id: number; type?: string }; from?: { id: number; is_bot?: boolean };
  message_thread_id?: number; is_topic_message?: boolean; text?: string;
};
type RawCallback = { id: string; from: { id: number }; data?: string; message?: { chat: { id: number; type?: string }; message_id: number; text?: string } };
export interface RawUpdate { update_id: number; message?: RawMessage; edited_message?: RawMessage; callback_query?: RawCallback }

export type Inbound =
  | { kind: "group"; update: DeskUpdate }
  | { kind: "dm"; chatId: number; fromId?: number; text?: string }
  | { kind: "dm-callback"; id: string; fromId: number };

const isGroup = (type: string | undefined) => type === "group" || type === "supergroup";
const FORWARD_KEYS = ["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "forward_date", "is_automatic_forward"];
const MEDIA_KEYS = ["photo", "document", "video", "voice", "audio", "sticker", "animation", "video_note", "contact", "location", "poll", "caption"];

/** A group message as the router sees it: who really wrote it (forwarded, via an inline bot,
 * posted as a chat, a bot), whether it's an edit, and whether it carries media. */
export function groupMessage(m: RawMessage, edited = false): DeskUpdate {
  return {
    kind: "message", chatId: m.chat.id, chatType: m.chat.type!, fromId: m.from?.id, messageId: m.message_id,
    threadId: m.message_thread_id, isTopic: m.is_topic_message, text: m.text,
    forwarded: FORWARD_KEYS.some((k) => m[k] !== undefined && m[k] !== false), viaBot: m.via_bot !== undefined,
    senderChat: m.sender_chat !== undefined, fromIsBot: m.from?.is_bot === true,
    edited: edited || m.edit_date !== undefined, media: MEDIA_KEYS.some((k) => m[k] !== undefined),
    date: typeof m.date === "number" ? m.date : undefined,
    newMembers: Array.isArray(m.new_chat_members) && m.new_chat_members.length > 0,
  };
}

export function classify(u: RawUpdate): Inbound | undefined {
  const m = u.message ?? u.edited_message;
  if (m) {
    if (isGroup(m.chat.type)) return { kind: "group", update: groupMessage(m, !u.message) };
    if (m.chat.type === "private" && u.message) return { kind: "dm", chatId: m.chat.id, fromId: m.from?.id, text: m.text };
    return undefined;
  }
  const cq = u.callback_query;
  if (cq?.message && isGroup(cq.message.chat.type)) {
    return { kind: "group", update: { kind: "callback", id: cq.id, chatId: cq.message.chat.id, fromId: cq.from.id, messageId: cq.message.message_id, data: cq.data, text: cq.message.text } };
  }
  if (cq) return { kind: "dm-callback", id: cq.id, fromId: cq.from.id };
  return undefined;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  if (signal.aborted) { r(); return; }
  const t = setTimeout(r, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
});

/** Telegram refused the token (401/404): retrying won't help, so the daemon exits. */
export class TokenRejected extends Error {}

/** Long-polls getUpdates and hands each update over without waiting on it. Resolves when
 * stopped; rejects with TokenRejected when Telegram won't accept the token. */
export class Poller {
  private offset = 0;
  constructor(private token: string, private log: (m: string) => void, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async run(onUpdate: (u: RawUpdate) => void, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/getUpdates`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: this.offset, timeout: 30, allowed_updates: ["message", "edited_message", "callback_query"] }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        });
        const json = await res.json() as { ok: boolean; result?: RawUpdate[]; description?: string; error_code?: number };
        if (!json.ok && (json.error_code === 401 || json.error_code === 404)) throw new TokenRejected(`telegram rejected the bot token (${json.error_code}: ${json.description ?? "no description"})`);
        if (!json.ok) {
          this.log(json.error_code === 409
            ? "telegram: another program is polling this bot's updates (409). Stop it: one bot token, one poller."
            : `telegram: getUpdates failed: ${json.description ?? res.status}`);
          await sleep(json.error_code === 409 ? 10_000 : 5000, signal);
          continue;
        }
        for (const u of json.result ?? []) {
          this.offset = u.update_id + 1;
          try { onUpdate(u); } catch (e) { this.log(`telegram: update ${u.update_id} failed: ${(e as Error).message}`); }
        }
      } catch (e) {
        if (e instanceof TokenRejected) throw e;
        if (signal.aborted) return;
        this.log(`telegram: poll error: ${(e as Error).message}`);
        await sleep(5000, signal);
      }
    }
  }
}
