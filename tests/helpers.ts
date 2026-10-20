/** Shared test harness: tmp dirs, identity constants, wait helpers, and the fake Telegram. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskButton, DeskTelegram } from "../src/desk/types.js";

export const tmp = () => mkdtempSync(join(tmpdir(), "ct-test-"));
export const OWNER = 42;
export const STRANGER = 666;
export const GROUP = -100123;
export const G = String(GROUP);

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
export const settle = () => new Promise((r) => setTimeout(r, 30));

export class FakeTelegram implements DeskTelegram {
  private nextTopic = 100;
  private nextMsg = 1;
  topics: { chat: string; id: number; name: string }[] = [];
  sent: { chat: string; thread?: number; text: string; buttons?: DeskButton[][]; id: number }[] = [];
  edits: { chat: string; id: number; text: string }[] = [];
  closed: number[] = [];
  reopened: number[] = [];
  renamed: { id: number; name: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  typingIn: number[] = [];
  chat: { type: string; is_forum?: boolean; username?: string; title?: string } = { type: "supergroup", is_forum: true };
  memberCount = 2;
  member: { status: string; can_manage_topics?: boolean } = { status: "administrator", can_manage_topics: true };
  failSend?: (text: string) => boolean;
  async getMe() { return { id: 999 }; }
  async getChat() { return this.chat; }
  async getChatMember() { return this.member; }
  async getChatMemberCount() { return this.memberCount; }
  async createTopic(chat: string, name: string) { const id = this.nextTopic++; this.topics.push({ chat, id, name }); return id; }
  async editTopic(_c: string, id: number, name: string) { this.renamed.push({ id, name }); }
  async closeTopic(_c: string, id: number) { this.closed.push(id); }
  async reopenTopic(_c: string, id: number) { this.reopened.push(id); }
  async send(chat: string, thread: number | undefined, text: string, buttons?: DeskButton[][]) {
    if (this.failSend?.(text)) throw new Error("telegram sendMessage: Bad Request: boom");
    const id = this.nextMsg++;
    this.sent.push({ chat, thread, text, buttons, id });
    return id;
  }
  async edit(chat: string, id: number, text: string) { this.edits.push({ chat, id, text }); }
  async typing(_c: string, thread: number) { this.typingIn.push(thread); }
  async answerCallback(id: string, text?: string) { this.answers.push({ id, text }); }
  inTopic(thread: number) { return this.sent.filter((s) => s.thread === thread).map((s) => s.text); }
}
