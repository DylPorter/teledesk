/** The narrow interfaces the desk router depends on. Nothing here knows about the
 * rest of the program; src/daemon.ts wires them up. */

/** An inline button: label and callback data (≤ 64 bytes). */
export interface DeskButton { text: string; data: string }

/** The Telegram Bot API calls the router makes. Each throws on failure (the error
 * message carries Telegram's description). Text is always sent as plain text. */
export interface DeskTelegram {
  getMe(): Promise<{ id: number }>;
  getChat(chatId: string): Promise<{ type: string; is_forum?: boolean; username?: string; title?: string }>;
  getChatMember(chatId: string, userId: number): Promise<{ status: string; can_manage_topics?: boolean }>;
  getChatMemberCount(chatId: string): Promise<number>;
  /** Create a forum topic; resolves to its message_thread_id. */
  createTopic(chatId: string, name: string): Promise<number>;
  editTopic(chatId: string, threadId: number, name: string): Promise<void>;
  /** Disappear a topic from the list (the inactivity sweep and group moves only; a session
   * exiting never closes anything). The history stays, and reopenTopic brings it back. */
  closeTopic(chatId: string, threadId: number): Promise<void>;
  reopenTopic(chatId: string, threadId: number): Promise<void>;
  /** One message (≤ 4096 characters) in a topic (threadId) or the group's General. Resolves to its id. */
  send(chatId: string, threadId: number | undefined, text: string, buttons?: DeskButton[][]): Promise<number>;
  /** Replace a message's text; its buttons go. */
  edit(chatId: string, messageId: number, text: string): Promise<void>;
  typing(chatId: string, threadId: number): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

/** An update from a group chat, as the bot's poll loop hands it over. For a message:
 * forwarded = any forward (forward_origin, forward_from…, is_automatic_forward); viaBot = sent
 * through an inline bot; senderChat = posted as a chat (anonymous admin, channel); fromIsBot = a
 * bot wrote it; edited = an edit of an earlier message; media = has a photo, file, voice… */
export type DeskUpdate =
  | { kind: "message"; chatId: number; chatType: string; fromId?: number; messageId: number; threadId?: number; isTopic?: boolean; text?: string;
      forwarded?: boolean; viaBot?: boolean; senderChat?: boolean; fromIsBot?: boolean; edited?: boolean; media?: boolean;
      /** When Telegram says it was sent (unix seconds). */ date?: number; /** A service message: people joined. */ newMembers?: boolean }
  | { kind: "callback"; id: string; chatId: number; fromId: number; messageId: number; data?: string; text?: string };

/** One folder's topic slot. slot 1 is the folder's own topic; 2, 3… are for extra
 * sessions open in the same folder at the same time ("#2"). */
export interface DeskSessionRow {
  id: number; cwd: string; slot: number;
  topic_id: number | null; topic_name: string | null; group_id: string | null;
  status: "live" | "offline"; pid: number | null; title: string | null; branch: string | null;
  /** When the session now holding this row started (UTC, 'YYYY-MM-DD HH:MM:SS'). */
  started_at: string | null;
  updated_at: string;
  /** 1 once the inactivity sweep has closed this topic: out of the sweep's reach but kept
   * (id and all) so the next session of this folder reopens exactly this topic. 0 again after. */
  topic_closed: number;
}

/** Where the router keeps desk sessions and the desk group id. */
export interface DeskState {
  group(): string | undefined;
  setGroup(chatId: string | undefined): void;
  get(id: number): DeskSessionRow | undefined;
  live(): DeskSessionRow[];
  /** The live row a reconnecting channel (same folder, same pid) left behind. */
  findLive(cwd: string, pid: number): DeskSessionRow | undefined;
  /** Mark the folder's first free slot live for this session (a new slot if all are live). */
  claim(cwd: string, pid: number, title: string, branch: string | undefined): DeskSessionRow;
  setTopic(id: number, groupId: string, topicId: number, name: string): void;
  setOffline(id: number): void;
  byTopic(groupId: string, topicId: number): DeskSessionRow | undefined;
  /** Offline rows with a topic the sweep hasn't closed yet, untouched since before `cutoff`
   * (UTC 'YYYY-MM-DD HH:MM:SS'). */
  stale(cutoff: string): DeskSessionRow[];
  /** Flag a row's topic as swept away (it keeps its id so /desk can bring it back). */
  markClosed(id: number): void;
}

export type DeskLog = (message: string) => void;
