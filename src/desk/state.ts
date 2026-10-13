/** DeskState on SQLite (node:sqlite, built into Node 22). The desk_sessions table lives in
 * whatever database it's given; the group id goes through the meta accessors it's handed
 * (sqliteMeta below keeps them in the same database). */
import type { DatabaseSync } from "node:sqlite";
import type { DeskSessionRow, DeskState } from "./types.js";

export const DESK_GROUP_KEY = "desk_group";

export interface MetaAccess {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Meta accessors on a small key/value table in the same database. */
export function sqliteMeta(db: DatabaseSync): MetaAccess {
  db.exec("CREATE TABLE IF NOT EXISTS desk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return {
    get: (k) => (db.prepare("SELECT value FROM desk_meta WHERE key = ?").get(k) as { value: string } | undefined)?.value,
    set: (k, v) => { db.prepare("INSERT INTO desk_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v); },
    delete: (k) => { db.prepare("DELETE FROM desk_meta WHERE key = ?").run(k); },
  };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS desk_sessions (
  id INTEGER PRIMARY KEY, cwd TEXT NOT NULL, slot INTEGER NOT NULL,
  topic_id INTEGER, topic_name TEXT, group_id TEXT,
  status TEXT NOT NULL DEFAULT 'offline', pid INTEGER, title TEXT, branch TEXT,
  started_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(cwd, slot))`;

export class SqliteDeskState implements DeskState {
  constructor(private db: DatabaseSync, private meta: MetaAccess) {
    db.exec(SCHEMA);
    const cols = db.prepare("PRAGMA table_info(desk_sessions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "started_at")) db.exec("ALTER TABLE desk_sessions ADD COLUMN started_at TEXT");
  }
  group(): string | undefined { return this.meta.get(DESK_GROUP_KEY); }
  setGroup(chatId: string | undefined): void {
    if (chatId === undefined) this.meta.delete(DESK_GROUP_KEY); else this.meta.set(DESK_GROUP_KEY, chatId);
  }
  get(id: number): DeskSessionRow | undefined {
    return this.db.prepare("SELECT * FROM desk_sessions WHERE id = ?").get(id) as DeskSessionRow | undefined;
  }
  live(): DeskSessionRow[] {
    return this.db.prepare("SELECT * FROM desk_sessions WHERE status = 'live' ORDER BY id").all() as unknown as DeskSessionRow[];
  }
  findLive(cwd: string, pid: number): DeskSessionRow | undefined {
    return this.db.prepare("SELECT * FROM desk_sessions WHERE cwd = ? AND pid = ? AND status = 'live'").get(cwd, pid) as DeskSessionRow | undefined;
  }
  claim(cwd: string, pid: number, title: string, branch: string | undefined): DeskSessionRow {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT * FROM desk_sessions WHERE cwd = ? ORDER BY slot").all(cwd) as unknown as DeskSessionRow[];
      const free = rows.find((r) => r.status !== "live");
      let id: number;
      if (free) {
        id = free.id;
        this.db.prepare("UPDATE desk_sessions SET status = 'live', pid = ?, title = ?, branch = ?, started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(pid, title, branch ?? null, id);
      } else {
        let slot = 1;
        while (rows.some((r) => r.slot === slot)) slot++;
        id = Number(this.db.prepare("INSERT INTO desk_sessions (cwd, slot, status, pid, title, branch, started_at) VALUES (?, ?, 'live', ?, ?, ?, datetime('now'))").run(cwd, slot, pid, title, branch ?? null).lastInsertRowid);
      }
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  setTopic(id: number, groupId: string, topicId: number, name: string): void {
    this.db.prepare("UPDATE desk_sessions SET group_id = ?, topic_id = ?, topic_name = ?, updated_at = datetime('now') WHERE id = ?").run(groupId, topicId, name, id);
  }
  setOffline(id: number): void {
    this.db.prepare("UPDATE desk_sessions SET status = 'offline', pid = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  }
  byTopic(groupId: string, topicId: number): DeskSessionRow | undefined {
    return this.db.prepare("SELECT * FROM desk_sessions WHERE group_id = ? AND topic_id = ? ORDER BY id DESC LIMIT 1").get(groupId, topicId) as DeskSessionRow | undefined;
  }
  stale(cutoff: string): DeskSessionRow[] {
    return this.db.prepare("SELECT * FROM desk_sessions WHERE status = 'offline' AND topic_id IS NOT NULL AND group_id IS NOT NULL AND updated_at < ? ORDER BY id").all(cutoff) as unknown as DeskSessionRow[];
  }
  clearTopic(id: number): void {
    this.db.prepare("UPDATE desk_sessions SET topic_id = NULL, topic_name = NULL, group_id = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  }
}
