/** DeskTelegram over the Bot API (plain fetch). Sends only: the bot's one poll loop
 * lives elsewhere and hands group updates to the router. */
import type { DeskButton, DeskTelegram } from "./types.js";

const keyboard = (buttons: DeskButton[][]) => ({ inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });

export class BotApi implements DeskTelegram {
  constructor(private token: string, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  /** One call. A 429 with a short retry_after is waited out and tried once more. */
  private async call<T>(method: string, body: Record<string, unknown>, retried = false): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json() as { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (json.ok) return json.result;
    const wait = json.parameters?.retry_after;
    if (json.error_code === 429 && !retried && wait !== undefined && wait <= 30) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.call(method, body, true);
    }
    throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  }

  getMe() { return this.call<{ id: number }>("getMe", {}); }
  getChat(chatId: string) { return this.call<{ type: string; is_forum?: boolean; username?: string }>("getChat", { chat_id: chatId }); }
  getChatMemberCount(chatId: string) { return this.call<number>("getChatMemberCount", { chat_id: chatId }); }
  getChatMember(chatId: string, userId: number) { return this.call<{ status: string; can_manage_topics?: boolean }>("getChatMember", { chat_id: chatId, user_id: userId }); }
  async createTopic(chatId: string, name: string): Promise<number> {
    return (await this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name })).message_thread_id;
  }
  async editTopic(chatId: string, threadId: number, name: string): Promise<void> { await this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name }); }
  async closeTopic(chatId: string, threadId: number): Promise<void> { await this.call("closeForumTopic", { chat_id: chatId, message_thread_id: threadId }); }
  async reopenTopic(chatId: string, threadId: number): Promise<void> { await this.call("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId }); }
  async send(chatId: string, threadId: number | undefined, text: string, buttons?: DeskButton[][]): Promise<number> {
    return (await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
    })).message_id;
  }
  async edit(chatId: string, messageId: number, text: string): Promise<void> {
    try { await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } }); }
    catch (e) { if (!/message is not modified/i.test((e as Error).message)) throw e; }
  }
  async typing(chatId: string, threadId: number): Promise<void> { await this.call("sendChatAction", { chat_id: chatId, message_thread_id: threadId, action: "typing" }); }
  async answerCallback(callbackId: string, text?: string): Promise<void> { await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) }); }
}
