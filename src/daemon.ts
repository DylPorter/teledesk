/** The teledesk daemon: one Telegram bot, one desk router. Group updates go to
 * the router; a direct message from the owner gets a short help reply with the live
 * sessions. Anyone else's direct messages are ignored. */
import { DatabaseSync } from "node:sqlite";
import { BotApi } from "./desk/bot-api.js";
import { DeskRouter } from "./desk/router.js";
import { SqliteDeskState, sqliteMeta } from "./desk/state.js";
import type { DeskState, DeskTelegram } from "./desk/types.js";
import { ensureDataDir, migrateLegacyDataDir, type DeskPaths } from "./paths.js";
import { classify, Poller, type RawUpdate } from "./poll.js";

export interface DaemonOptions {
  /** The owner's Telegram user id (TELEGRAM_ALLOWED_USER_ID). */
  ownerId: string;
  paths: DeskPaths;
  log: (m: string) => void;
  /** Bot token; needed unless both telegram and poller are given (tests). */
  token?: string;
  telegram?: DeskTelegram;
  poller?: { run(onUpdate: (u: RawUpdate) => void, signal: AbortSignal): Promise<void> };
  alive?: (pid: number) => boolean;
  graceMs?: number;
  /** Ended sessions' topics are deleted after this many days without activity (default 7). */
  topicTtlDays?: number;
  /** Polling can't continue (Telegram rejected the token). */
  onFatal?: (e: Error) => void;
}

export function helpText(state: DeskState): string {
  const live = state.live();
  const sessions = live.length
    ? live.map((r) => `• ${r.topic_name ?? r.title ?? "session"}: ${r.cwd}`).join("\n")
    : "none";
  return [
    "This bot puts each Claude Code session in its own Telegram topic.",
    "",
    "Set up once:",
    "1. Create a group with just you and this bot, and turn on Topics in its settings.",
    "2. Make the bot an admin with the Manage topics right.",
    "3. Send /desk_here in the group.",
    "",
    "Then start Claude Code with `teledesk code` (or run `teledesk install` once and plain `claude` works too). Inside a session, /desk opens its topic here: write there to talk to it, and its permission prompts show up there with Allow and Deny. /desk off closes it.",
    "",
    "Topics of ended sessions are deleted after 7 days of inactivity (DESK_TOPIC_TTL_DAYS); the transcripts on this machine are untouched.",
    "",
    `Desk group: ${state.group() ? "set up" : "not set up yet"}`,
    `Live sessions (${live.length}):`,
    sessions,
  ].join("\n");
}

/** How often the stale-topic sweep runs. */
export const SWEEP_EVERY_MS = 3_600_000;

export class DeskDaemon {
  router?: DeskRouter;
  state?: SqliteDeskState;
  private db?: DatabaseSync;
  private abort = new AbortController();
  private polling?: Promise<void>;
  private sweepTimer?: NodeJS.Timeout;
  private tg: DeskTelegram;
  private loggedDm = new Set<string>();

  constructor(private o: DaemonOptions) {
    if (!o.telegram && !o.token) throw new Error("a bot token is required");
    this.tg = o.telegram ?? new BotApi(o.token!);
  }

  async start(): Promise<void> {
    const { paths, log } = this.o;
    const moved = migrateLegacyDataDir(paths); // the pre-rename folder, once
    if (moved) log(`teledesk: moved the data folder from ${moved}`);
    ensureDataDir(paths.dataDir); // throws if the folder isn't safe, before anything is opened in it
    this.db = new DatabaseSync(paths.db);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.state = new SqliteDeskState(this.db, sqliteMeta(this.db));
    this.router = new DeskRouter({ socketPath: paths.socket, ownerId: this.o.ownerId, telegram: this.tg, state: this.state, log, alive: this.o.alive, graceMs: this.o.graceMs, topicTtlDays: this.o.topicTtlDays });
    try { await this.router.start(); }
    catch (e) { this.db.close(); this.db = undefined; throw e; }
    const sweep = () => void this.router?.sweepStaleTopics().catch((e: Error) => log(`teledesk: topic sweep failed: ${e.message}`));
    sweep();
    this.sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
    this.sweepTimer.unref();
    const poller = this.o.poller ?? new Poller(this.o.token!, log);
    this.polling = poller.run((u) => this.onUpdate(u), this.abort.signal).catch((e: Error) => {
      log(`teledesk: polling stopped: ${e.message}`);
      this.o.onFatal?.(e);
    });
    log(`teledesk: listening on ${paths.socket}`);
  }

  /** One raw update. Never waits on Telegram, so the poll loop keeps moving. */
  onUpdate(u: RawUpdate): void {
    const c = classify(u);
    if (!c) return;
    if (c.kind === "group") { void this.router?.onUpdate(c.update); return; }
    if (c.kind === "dm-callback") { void this.tg.answerCallback(c.id).catch(() => undefined); return; }
    if (String(c.fromId) !== this.o.ownerId) {
      const who = String(c.fromId ?? "unknown");
      if (!this.loggedDm.has(who)) { if (this.loggedDm.size >= 1000) this.loggedDm.clear(); this.loggedDm.add(who); this.o.log(`teledesk: ignored a direct message from user ${who} (only the owner's count)`); }
      return;
    }
    if (!this.state) return;
    void this.tg.send(String(c.chatId), undefined, helpText(this.state)).catch((e: Error) => this.o.log(`teledesk: couldn't answer a direct message: ${e.message}`));
  }

  /** Stop polling and close the socket. Open sessions aren't ended: their channel servers keep
   * retrying and pick up their topics again when the daemon is back. A session that ends while
   * the daemon is down is closed ("Session ended") when it starts again. */
  async stop(): Promise<void> {
    this.abort.abort();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }
    await this.router?.stop();
    await this.polling?.catch(() => undefined);
    this.db?.close();
    this.db = undefined;
  }
}
