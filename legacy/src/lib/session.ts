import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

// Simple per-chat session state, persisted to a JSON file.
// Claude Code sessions are identified by UUID (from --output-format json response);
// we resume with --resume <uuid>.

/**
 * Where unpinned-vs-pinned text goes. `pane` = a live tmux Claude session
 * (by tmux pane id); `bot` = this chat's own `claude -p` conversation.
 */
export type Pin =
  | { kind: "pane"; paneId: string; label: string }
  | { kind: "bot" };

interface ChatSession {
  chatId: number;
  sessionId: string | null; // Claude Code session UUID
  cwd: string;              // Working dir for this chat
  updatedAt: string;
  pin?: Pin | null;
  /** Where the last unpinned message went; sticky routing sends follow-ups there. */
  last?: Pin | null;
  lastAt?: string | null;
}

interface Store {
  chats: Record<string, ChatSession>;
}

const FILE = path.join(env.STATE_DIR, "sessions.json");

async function load(): Promise<Store> {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return { chats: {} };
  }
}

async function save(store: Store): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2));
}

export async function getSession(chatId: number): Promise<ChatSession> {
  const store = await load();
  const key = String(chatId);
  if (!store.chats[key]) {
    store.chats[key] = {
      chatId,
      sessionId: null,
      cwd: env.DEFAULT_CWD,
      updatedAt: new Date().toISOString(),
    };
    await save(store);
  }
  return store.chats[key];
}

export async function updateSession(
  chatId: number,
  patch: Partial<Omit<ChatSession, "chatId">>,
): Promise<ChatSession> {
  const store = await load();
  const key = String(chatId);
  const current = store.chats[key] ?? {
    chatId,
    sessionId: null,
    cwd: env.DEFAULT_CWD,
    updatedAt: new Date().toISOString(),
  };
  const next: ChatSession = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.chats[key] = next;
  await save(store);
  return next;
}

export async function resetSession(chatId: number): Promise<void> {
  await updateSession(chatId, { sessionId: null });
}
