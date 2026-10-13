/** The daemon side of desk sessions. Each Claude Code session's channel server
 * connects to a unix socket here; the router gives it a forum topic in the owner's
 * desk group and relays: owner's messages in the topic → that session, its replies
 * and permission prompts → that topic. Only text the owner wrote ever reaches a
 * session: gated on the sender's user id, and forwards, inline-bot messages and
 * posts made as a chat are dropped. Depends only on ./types.ts interfaces. */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { ChannelMessage, clip, decode, encode, LineReader, oneLine, VERDICT_TEXT, type DaemonMessage } from "./protocol.js";
import { CHUNK, cleanText, INVISIBLE, promptMessages, tooLongText } from "./prompt.js";
import type { DeskLog, DeskSessionRow, DeskState, DeskTelegram, DeskUpdate } from "./types.js";

export const NO_SESSION_TEXT = "No Claude Code session is open for this folder. Start one with `claude-telegram code` there.";
export const RECONNECTING_TEXT = "This session is reconnecting to the claude-telegram daemon. Send that again in a few seconds.";
export const NO_GROUP_REASON = "No desk group is set up. In Telegram: create a group, turn on Topics, add the bot as an admin with Manage topics, then send /desk_here in the group.";
export const GENERAL_HINT = "A session's topic opens when /desk turns its desk on (sessions started via `claude-telegram code` or the shell hook). Write in a session's topic to talk to it.";
export const FORWARD_TEXT = "Forwarded messages aren't passed to the session. Paste the text if you want it acted on.";
export const TEXT_ONLY = "Only text messages reach the session for now.";
export const EARLIER_SESSION = "This prompt belongs to an earlier session.";
export const NO_PROMPT = "No open prompt with that code in this session.";
export { CHUNK, promptMessages, tooLongText };
export const BEFORE_SESSION = "That message was sent before this session started, so it wasn't passed on.";
export const PRIVACY_OFF = "Someone besides you and the bot is in this group now, so desk is off here: they could read your sessions. Remove them, then send /desk_here again.";
/** Telegram's clock vs ours: messages up to this much older than a session's start still count. */
const CLOCK_SLACK_MS = 60_000;
const MAX_CONNECTIONS = 32;
const ANSWERED_KEEP = 200;
const PENDING_KEEP = 50;
/** Above this many unhandled messages a connection stops being read until it catches up. */
const BACKLOG_PAUSE = 8;
const BACKLOG_RESUME = 2;
/** Every part of a Claude reply starts with this, and nothing the router writes ever does: the
 * owner can always tell Claude's words from the router's own messages and prompts. */
export const REPLY_MARK = "🤖 ";
/** Fail-closed limits: what one local process or one runaway session can make the router do. */
export interface DeskLimits {
  /** Live sessions with a topic, all together. */
  sessions: number;
  /** Sessions started (topic created or reopened) per minute, all together. */
  startsPerMinute: number;
  /** Topics created per minute, all together. */
  topicsPerMinute: number;
  /** Messages one session may post per minute; more wait their turn. */
  sendsPerMinute: number;
  /** How long part of a line may wait for the rest (while the router is reading). */
  partialLineMs: number;
  /** How often sessions waiting for a topic are tried again. */
  retryWaitingMs: number;
  /** Group updates waiting to be handled; past this, new ones are dropped. */
  queuedUpdates: number;
}
export const DEFAULT_LIMITS: DeskLimits = { sessions: 20, startsPerMinute: 10, topicsPerMinute: 5, sendsPerMinute: 20, partialLineMs: 30_000, retryWaitingMs: 20_000, queuedUpdates: 500 };
/** Size bound for the sets and maps that remember senders, chats and notices. */
const MEMORY_KEEP = 1000;
/** Control characters (newlines and tabs stay), direction overrides and invisible characters
 * come out of replies, so a reply can't reorder or hide what's around it. */
const REPLY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export const replyText = (t: string) => t.replace(REPLY_CONTROL, " ").replace(INVISIBLE, "");
/** How often the forwarded-message notice may repeat in one topic. */
const NOTICE_EVERY_MS = 10 * 60_000;

/** Callback data on a permission prompt's buttons. The channel's pid names the exact session:
 * a row is reused by later sessions in the same folder, the pid isn't. */
export const permissionData = (sessionId: number, pid: number, requestId: string, allow: boolean) => `dp:${sessionId}:${pid}:${requestId}:${allow ? "y" : "n"}`;
const PERMISSION_DATA = /^dp:(\d+):(\d+):([a-km-z]{5}):(y|n)$/;
const DESK_HERE = /^\/desk_here(?:@\w+)?\s*$/i;
const DESK_OFF = /^\/desk_off(?:@\w+)?\s*$/i;

type Hello = Extract<ChannelMessage, { type: "hello" }>;
interface Conn {
  sock: Socket;
  hello?: Hello;
  helloTimer?: NodeJS.Timeout;
  sessionId?: number;
  /** The session ended (bye or disconnect): nothing more is relayed to or from it. */
  ended: boolean;
  /** Replaced by a newer connection from the same channel: closing it ends nothing. */
  superseded: boolean;
  /** This connection's messages are handled one at a time, in order. */
  queue: Promise<void>;
  backlog: number;
  paused: boolean;
  /** Open permission prompts: request id → the message with the buttons. */
  pending: Map<string, { messageId: number; text: string }>;
  answered: Set<string>;
  /** When this connection's last messages were posted (pacing). */
  sent: number[];
  /** A topic-failure notice was already posted in General for this session. */
  noticed: boolean;
}

export interface DeskRouterOptions {
  socketPath: string;
  /** The owner's Telegram user id. Nothing from anyone else reaches a session. */
  ownerId: string;
  telegram: DeskTelegram;
  state: DeskState;
  log: DeskLog;
  /** Whether a process is still running (default: signal 0). */
  alive?: (pid: number) => boolean;
  /** After a restart, how long a live session has to reconnect before it's ended. */
  graceMs?: number;
  /** How long a new connection has to say hello. */
  helloTimeoutMs?: number;
  /** Wait before retrying a failed topic creation. */
  retryMs?: number;
  /** Ended sessions' topics are deleted after this many days without activity (default 7). */
  topicTtlDays?: number;
  limits?: Partial<DeskLimits>;
}

/** A topic name: "<folder> · <branch>", "#2" for a second session in the same folder, ≤ 128 chars. */
export function topicName(title: string, branch: string | undefined, slot: number): string {
  const clean = (s: string) => oneLine(s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  const suffix = slot > 1 ? ` #${slot}` : "";
  const base = clean(title) || "session";
  const b = branch ? clean(branch) : "";
  return clip(b ? `${base} · ${b}` : base, 128 - suffix.length) + suffix;
}

/** Split text into Telegram-sized parts, preferring line breaks. */
export function chunkText(text: string, size = CHUNK): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    // Never split a surrogate pair.
    if (cut === size && /[\ud800-\udbff]/.test(rest[cut - 1])) cut--;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Whether something is accepting connections on a unix socket. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const done = (v: boolean) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(false), 1000);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const defaultAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const errText = (e: unknown) => (e as Error)?.message ?? String(e);
const notModified = (e: unknown) => /TOPIC_NOT_MODIFIED|not modified/i.test(errText(e));

export class DeskRouter {
  private server?: Server;
  /** Held while this router runs (Linux): a second one for the same socket can't start at all. */
  private lockServer?: Server;
  private conns = new Set<Conn>();
  private bySession = new Map<number, Conn>();
  private stopping = false;
  private loggedSenders = new Set<string>();
  private loggedChats = new Set<string>();
  /** Groups the owner already got a wrong-group DM about (once each, per daemon run). */
  private hintedChats = new Set<string>();
  private graceTimers = new Map<number, NodeJS.Timeout>();
  private locks = new Map<string, Promise<void>>();
  /** Group updates are handled one at a time, in arrival order. */
  private updates: Promise<void> = Promise.resolve();
  private noticeAt = new Map<string, number>();
  private queuedUpdates = 0;
  private starts: number[] = [];
  private topicsMade: number[] = [];
  private retryTimer?: NodeJS.Timeout;
  private limitLogAt = new Map<string, number>();
  private lim: DeskLimits;
  private tg: DeskTelegram;
  private state: DeskState;
  private log: DeskLog;
  private alive: (pid: number) => boolean;

  constructor(private opts: DeskRouterOptions) {
    this.tg = opts.telegram;
    this.state = opts.state;
    this.log = opts.log;
    this.alive = opts.alive ?? defaultAlive;
    this.lim = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  /** Room in a one-minute window? Takes a slot if so. */
  private take(window: number[], max: number): boolean {
    const now = Date.now();
    while (window.length && now - window[0] >= 60_000) window.shift();
    if (window.length >= max) return false;
    window.push(now);
    return true;
  }

  /** A limit was hit: log it (at most once a minute per kind) and tell the session. */
  private refuse(conn: Conn, kind: string, reason: string): void {
    const now = Date.now();
    if (now - (this.limitLogAt.get(kind) ?? 0) >= 60_000) { this.limitLogAt.set(kind, now); this.log(`desk: limit reached (${kind}): ${reason}`); }
    this.write(conn, { type: "error", reason });
  }

  /** Wait until this session may post again (sendsPerMinute), so one session can't use up the
   * group's Telegram quota for the others. */
  private async pace(conn: Conn): Promise<void> {
    for (;;) {
      if (this.stopping || conn.ended) throw new Error("session closed while waiting to post");
      const now = Date.now();
      while (conn.sent.length && now - conn.sent[0] >= 60_000) conn.sent.shift();
      if (conn.sent.length < this.lim.sendsPerMinute) { conn.sent.push(now); return; }
      await new Promise((r) => setTimeout(r, Math.min(1000, 60_000 - (now - conn.sent[0]) + 5)));
    }
  }

  /** Sessions waiting for a topic (a limit, a failed topic, or a group change) are tried again. */
  private retryWaiting(): void {
    const group = this.state.group();
    if (!group || this.stopping) return;
    for (const c of this.conns) {
      if (!c.hello || c.ended) continue;
      if (c.sessionId === undefined || this.state.get(c.sessionId)?.group_id !== group) void this.lock(c.hello.cwd, () => this.attach(c));
    }
  }

  // ---- lifecycle ----
  async start(): Promise<void> {
    const path = this.opts.socketPath;
    // Only in a folder no one else can write to: otherwise another user could swap the socket.
    const dir = dirname(path);
    const st = statSync(dir);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} isn't owned by this user; not listening there`);
    if (st.mode & 0o022) throw new Error(`${dir} is writable by other users; not listening there (chmod go-w it)`);
    await this.takeLock(path);
    try { await this.listen(path); } catch (e) { this.lockServer?.close(); this.lockServer = undefined; throw e; }
    this.retryTimer = setInterval(() => this.retryWaiting(), this.lim.retryWaitingMs).unref();
  }

  /** On Linux, an abstract-namespace socket named after this user and socket path: binding it is
   * atomic and the kernel releases it when the process exits, so two routers can't both start. */
  private async takeLock(path: string): Promise<void> {
    if (process.platform !== "linux") return;
    const name = `\0claude-desk-${createHash("sha256").update(`${process.getuid?.()}:${path}`).digest("hex").slice(0, 32)}`;
    const lock = createServer((s) => s.destroy());
    await new Promise<void>((resolve, reject) => { lock.once("error", reject); lock.listen(name, () => resolve()); })
      .catch((e: NodeJS.ErrnoException) => { throw e.code === "EADDRINUSE" ? new Error(`another desk router is already running for ${path}`) : e; });
    this.lockServer = lock;
  }

  private async listen(path: string): Promise<void> {
    let existing;
    try { existing = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (existing && !existing.isSocket()) throw new Error(`${path} exists and isn't a socket; not touching it`);
    if (existing) {
      if (await answers(path)) throw new Error(`another desk router is already listening on ${path}`);
      unlinkSync(path);
    }
    const server = createServer((sock) => this.onConnection(sock));
    this.server = server;
    const listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => { server.off("error", reject); resolve(); });
    });
    // The socket file is created inside listen() itself: owner-only from the start (umask set
    // only around that call), then chmod as well in case umask can't be set in this thread.
    let restore: number | undefined;
    try { restore = process.umask(0o177); } catch { /* not settable here */ }
    try { server.listen(path); } finally { if (restore !== undefined) process.umask(restore); }
    await listening;
    chmodSync(path, 0o600);
    // Only now that this router owns the socket: sessions left live by the last one close if they
    // ended meanwhile, and running ones get time to reconnect. (Runs before any connection is handled.)
    for (const row of this.state.live()) {
      if (!row.pid || !this.alive(row.pid)) void this.lock(row.cwd, () => this.endRow(row.id));
      else this.graceTimers.set(row.id, setTimeout(() => {
        this.graceTimers.delete(row.id);
        if (!this.bySession.has(row.id)) void this.lock(row.cwd, () => this.endRow(row.id, row.pid));
      }, this.opts.graceMs ?? 90_000).unref());
    }
    server.on("error", (e) => this.log(`desk: socket error: ${e.message}`));
  }

  /** Daemon shutdown: drop the connections without ending their sessions (they reconnect). */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const c of this.conns) { clearTimeout(c.helloTimer); c.sock.destroy(); }
    const server = this.server;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.lockServer?.close();
    this.lockServer = undefined;
    clearInterval(this.retryTimer);
    try { if (lstatSync(this.opts.socketPath).isSocket()) unlinkSync(this.opts.socketPath); } catch { /* gone */ }
  }

  /** Run fn after any earlier fn for the same folder: topic opening and closing never interleave. */
  private lock(key: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn).catch((e) => this.log(`desk: ${errText(e)}`));
    this.locks.set(key, run);
    void run.then(() => { if (this.locks.get(key) === run) this.locks.delete(key); });
    return run;
  }

  // ---- channel connections ----
  private onConnection(sock: Socket): void {
    if (this.stopping || this.conns.size >= MAX_CONNECTIONS) { sock.destroy(); return; }
    const conn: Conn = { sock, ended: false, superseded: false, queue: Promise.resolve(), backlog: 0, paused: false, pending: new Map(), answered: new Set(), sent: [], noticed: false };
    this.conns.add(conn);
    // A connection that never says hello would hold a slot forever.
    conn.helloTimer = setTimeout(() => { if (!conn.hello) sock.destroy(); }, this.opts.helloTimeoutMs ?? 10_000).unref();
    // Part of a line may wait for the rest only so long, and only while the router is reading
    // (a paused socket isn't the peer's fault).
    let partialTimer: NodeJS.Timeout | undefined;
    const armPartial = () => {
      if (reader.partial && !conn.paused) {
        partialTimer ??= setTimeout(() => { this.log("desk: a channel left a line unfinished; disconnected it"); sock.destroy(); }, this.lim.partialLineMs).unref();
      } else if (partialTimer) { clearTimeout(partialTimer); partialTimer = undefined; }
    };
    const enqueue = (fn: () => Promise<void>) => {
      conn.backlog++;
      if (conn.backlog >= BACKLOG_PAUSE && !conn.paused) { conn.paused = true; sock.pause(); armPartial(); }
      conn.queue = conn.queue.then(fn).catch((e) => this.log(`desk: ${errText(e)}`)).finally(() => {
        conn.backlog--;
        if (conn.paused && conn.backlog <= BACKLOG_RESUME) { conn.paused = false; sock.resume(); armPartial(); }
      });
    };
    const reader = new LineReader((line) => {
      const m = decode(ChannelMessage, line);
      enqueue(() => m ? this.handle(conn, m) : Promise.resolve(this.write(conn, { type: "error", reason: "That wasn't a valid desk message." })));
    });
    sock.on("data", (d) => {
      if (!reader.push(d)) {
        this.log("desk: a channel sent an oversized line; disconnected it");
        sock.destroy();
        return;
      }
      armPartial();
    });
    sock.on("error", () => { /* close follows */ });
    sock.on("close", () => {
      clearTimeout(partialTimer);
      clearTimeout(conn.helloTimer);
      this.conns.delete(conn);
      enqueue(() => this.onClose(conn));
    });
  }

  private write(conn: Conn, m: DaemonMessage): void {
    if (!conn.sock.destroyed && conn.sock.writable) conn.sock.write(encode(m));
  }

  private async onClose(conn: Conn): Promise<void> {
    if (this.stopping || conn.superseded) {
      if (conn.sessionId !== undefined && this.bySession.get(conn.sessionId) === conn) this.bySession.delete(conn.sessionId);
      return;
    }
    if (conn.hello) await this.lock(conn.hello.cwd, () => this.endSession(conn));
  }

  private async handle(conn: Conn, m: ChannelMessage): Promise<void> {
    if (conn.ended) return;
    if (m.type === "hello") {
      if (conn.hello) { this.write(conn, { type: "error", reason: "hello was already sent on this connection" }); return; }
      conn.hello = m;
      clearTimeout(conn.helloTimer);
      await this.lock(m.cwd, () => this.attach(conn));
      return;
    }
    if (m.type === "bye") {
      if (conn.hello) await this.lock(conn.hello.cwd, () => this.endSession(conn));
      conn.sock.end();
      return;
    }
    const row = this.topicOf(conn);
    if (!row) { this.write(conn, { type: "error", reason: this.state.group() ? "This session has no topic yet." : NO_GROUP_REASON }); return; }
    if (m.type === "reply") {
      // Every part carries the reply mark, whatever Claude wrote: it can't pass for the router.
      const failed = await this.post(row.group_id, row.topic_id, replyText(m.text), { shape: (p) => REPLY_MARK + p, before: () => this.pace(conn) });
      if (failed) await this.post(row.group_id, row.topic_id, `⚠️ ${failed} part(s) of that reply didn't send.`);
      return;
    }
    await this.prompt(conn, row, m);
  }

  /** Post a permission prompt: details first if they need a message of their own, the buttons last.
   * It becomes answerable from Telegram only once every part of it has been shown. If any part
   * fails, the owner is told to answer in the terminal, and no answer from here is accepted. */
  private async prompt(conn: Conn, row: DeskSessionRow & { group_id: string; topic_id: number }, m: Extract<ChannelMessage, { type: "permission_request" }>): Promise<void> {
    const parts = m.too_long ? undefined : promptMessages(m.tool_name, m.description, m.input_preview, m.request_id);
    if (!parts) { await this.post(row.group_id, row.topic_id, tooLongText(m.tool_name)); return; }
    const buttons = [[{ text: "Allow", data: permissionData(row.id, conn.hello!.pid, m.request_id, true) }, { text: "Deny", data: permissionData(row.id, conn.hello!.pid, m.request_id, false) }]];
    const text = parts.at(-1)!;
    let mid: number | undefined;
    try {
      for (const p of parts.slice(0, -1)) { await this.pace(conn); await this.tg.send(row.group_id, row.topic_id, p); }
      await this.pace(conn);
      mid = await this.tg.send(row.group_id, row.topic_id, text, buttons);
    } catch (e) { this.log(`desk: couldn't show a permission prompt for session ${row.id}: ${errText(e)}`); }
    if (mid === undefined) {
      await this.post(row.group_id, row.topic_id, `🔐 Claude is asking to use ${clip(cleanText(m.tool_name), 100)}, but the prompt couldn't be shown here. Answer it in the terminal.`);
      return;
    }
    conn.pending.set(m.request_id, { messageId: mid, text });
    if (conn.pending.size > PENDING_KEEP) {
      const [oldId, old] = conn.pending.entries().next().value!;
      conn.pending.delete(oldId);
      await this.tg.edit(row.group_id, old.messageId, `${old.text}\n\nNo longer tracked here; answer it in the terminal.`).catch(() => undefined);
    }
  }

  /** The row and topic a connection's output goes to, if it's attached in the current group. */
  private topicOf(conn: Conn): (DeskSessionRow & { group_id: string; topic_id: number }) | undefined {
    if (conn.sessionId === undefined) return undefined;
    const row = this.state.get(conn.sessionId);
    const group = this.state.group();
    if (!row || !group || row.group_id !== group || row.topic_id === null) return undefined;
    return row as DeskSessionRow & { group_id: string; topic_id: number };
  }

  /** Give a connected session its topic: the same one again after a daemon restart, the
   * folder's topic reopened, or a new one. Safe to call again (e.g. after /desk_here). */
  private async attach(conn: Conn): Promise<void> {
    const h = conn.hello;
    if (!h || conn.ended || this.stopping) return;
    const group = this.state.group();
    if (!group) { this.write(conn, { type: "error", reason: NO_GROUP_REASON }); return; }
    let row = this.state.findLive(h.cwd, h.pid);
    if (row && row.group_id === group && row.topic_id !== null) {
      // The same channel reconnecting (daemon restart, or a dropped socket).
      this.bind(conn, row.id);
      this.write(conn, { type: "welcome", session_id: row.id, topic_name: row.topic_name ?? "" });
      return;
    }
    if (row?.group_id && row.topic_id !== null && row.group_id !== group) {
      // Moving to a new desk group: the old topic says so and closes.
      await this.post(row.group_id, row.topic_id, "Moved to another desk group.");
      await this.tg.closeTopic(row.group_id, row.topic_id).catch(() => undefined);
    }
    // Limits, checked before anything reaches Telegram. Refused sessions are tried again later.
    const bound = conn.sessionId !== undefined && this.bySession.get(conn.sessionId) === conn;
    if (!bound && this.bySession.size >= this.lim.sessions) { this.refuse(conn, "sessions", `There are already ${this.lim.sessions} open desk sessions; this one gets a topic when one of them ends.`); return; }
    if (!this.take(this.starts, this.lim.startsPerMinute)) { this.refuse(conn, "starts", "Too many sessions started in the last minute; this one gets a topic shortly."); return; }
    // Someone may have joined since /desk_here: check again before a session's text goes there.
    const count = await this.tg.getChatMemberCount(group).catch(() => undefined);
    if (count !== undefined && count > 2) { await this.privacyBreach(group, `the group has ${count} members`); this.write(conn, { type: "error", reason: NO_GROUP_REASON }); return; }
    row ??= this.state.claim(h.cwd, h.pid, h.title, h.branch);
    const name = topicName(h.title, h.branch, row.slot);
    let topic: number | undefined;
    if (row.topic_id !== null && row.group_id === group) {
      try { await this.tg.reopenTopic(group, row.topic_id); topic = row.topic_id; }
      catch (e) { if (notModified(e)) topic = row.topic_id; else this.log(`desk: couldn't reopen topic ${row.topic_id} (${errText(e)}); opening a new one`); }
      if (topic !== undefined && row.topic_name !== name) await this.tg.editTopic(group, topic, name).catch((e) => { if (!notModified(e)) this.log(`desk: couldn't rename topic: ${errText(e)}`); });
    }
    if (topic === undefined && !this.take(this.topicsMade, this.lim.topicsPerMinute)) {
      this.state.setOffline(row.id);
      this.refuse(conn, "topics", "Too many topics created in the last minute; this session gets one shortly.");
      return;
    }
    if (topic === undefined) {
      let err: unknown;
      for (let attempt = 0; attempt < 2 && topic === undefined; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 3000));
        try { topic = await this.tg.createTopic(group, name); } catch (e) { err = e; this.log(`desk: couldn't create a topic: ${errText(e)}`); }
      }
      if (topic === undefined) {
        this.state.setOffline(row.id);
        if (!conn.noticed) { conn.noticed = true; await this.post(group, undefined, `Couldn't open a topic for the session in ${h.cwd}: ${clip(errText(err), 300)}. It's tried again shortly.`); }
        this.write(conn, { type: "error", reason: `Couldn't open a Telegram topic: ${clip(errText(err), 300)}` });
        return;
      }
    }
    this.state.setTopic(row.id, group, topic, name);
    this.bind(conn, row.id);
    await this.post(group, topic, `▶️ Session started\n${h.cwd}${h.branch ? ` (${h.branch})` : ""}`);
    this.write(conn, { type: "welcome", session_id: row.id, topic_name: name });
  }

  private bind(conn: Conn, id: number): void {
    const old = this.bySession.get(id);
    if (old && old !== conn) {
      old.superseded = true;
      old.sock.destroy();
      // The same channel reconnecting: its shown prompts are still open, so they stay answerable.
      if (old.hello?.pid === conn.hello?.pid) { conn.pending = old.pending; conn.answered = old.answered; }
    }
    conn.sessionId = id;
    this.bySession.set(id, conn);
    const t = this.graceTimers.get(id);
    if (t) { clearTimeout(t); this.graceTimers.delete(id); }
  }

  /** The session is over: its open prompts lose their buttons, "Session ended", topic closed. */
  private async endSession(conn: Conn): Promise<void> {
    if (conn.ended) return;
    conn.ended = true;
    const id = conn.sessionId;
    if (id === undefined) return;
    if (this.bySession.get(id) === conn) this.bySession.delete(id);
    const row = this.state.get(id);
    if (row?.group_id) {
      for (const p of conn.pending.values()) await this.tg.edit(row.group_id, p.messageId, `${p.text}\n\nSession ended before an answer.`).catch(() => undefined);
    }
    conn.pending.clear();
    await this.endRow(id, conn.hello?.pid);
  }

  /** Close a row's topic and mark it offline (only if it's still the same live session). */
  private async endRow(id: number, pid?: number | null): Promise<void> {
    const row = this.state.get(id);
    if (!row || row.status !== "live" || (pid != null && row.pid !== pid)) return;
    if (this.bySession.has(id)) return; // reconnected meanwhile
    if (row.group_id && row.topic_id !== null) {
      await this.post(row.group_id, row.topic_id, "⏹ Session ended");
      await this.tg.closeTopic(row.group_id, row.topic_id).catch((e) => { if (!notModified(e)) this.log(`desk: couldn't close topic ${row.topic_id}: ${errText(e)}`); });
    }
    this.state.setOffline(id);
  }

  /** Send text to a topic in ≤ CHUNK parts (each part through `shape`, each send after `before`).
   * A failed part is logged and the rest still go. Resolves to how many parts failed. */
  private async post(chatId: string, threadId: number | undefined, text: string, o: { shape?: (part: string) => string; before?: () => Promise<void> } = {}): Promise<number> {
    const parts = chunkText(text, o.shape ? CHUNK - 8 : CHUNK);
    let failed = 0;
    for (const p of parts) {
      try { await o.before?.(); await this.tg.send(chatId, threadId, o.shape ? o.shape(p) : p); } catch (e) { failed++; this.log(`desk: send failed: ${errText(e)}`); }
    }
    if (failed) this.log(`desk: ${failed} of ${parts.length} part(s) didn't send`);
    return failed;
  }

  /** Someone else can see the desk group: stop using it until the owner sets it up again. */
  private async privacyBreach(chat: string, why: string): Promise<void> {
    if (this.state.group() !== chat) return;
    this.state.setGroup(undefined);
    this.log(`desk: turned desk off in ${chat}: ${why}`);
    await this.post(chat, undefined, PRIVACY_OFF);
  }

  /** The owner wrote in a group that isn't the desk group: nothing there reaches a session, and
   * silence just looks like a broken bot (a same-named old group is exactly how that happens).
   * Tell them once per group, by DM — the wrong group itself may have readers who should learn
   * nothing about the desk. */
  private async wrongGroupHint(chat: string): Promise<void> {
    if (this.hintedChats.has(chat)) return;
    if (this.hintedChats.size >= MEMORY_KEEP) this.hintedChats.clear();
    this.hintedChats.add(chat);
    let title: string | undefined;
    try { title = (await this.tg.getChat(chat)).title; } catch { /* the id identifies the group either way */ }
    const text = `Your message in${title ? ` "${title}"` : " a group"} reached no session: that group isn't the desk group.\nSend /desk_here there to make it one.\nGroup id: ${chat}`;
    await this.tg.send(this.opts.ownerId, undefined, text).catch((e) => this.log(`desk: couldn't tell the owner about group ${chat}: ${errText(e)}`));
  }

  /** Delete ended sessions' topics that nothing touched for the TTL (default 7 days): the
   * transcripts are local and stay, but an endless list of dead topics buries the live ones.
   * A topic whose deletion fails is left for the next sweep. Returns how many were deleted. */
  async sweepStaleTopics(now = new Date()): Promise<number> {
    const ttlDays = this.opts.topicTtlDays ?? 7;
    const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    let swept = 0;
    for (const row of this.state.stale(cutoff)) {
      if (!row.group_id || row.topic_id === null) continue;
      try { await this.tg.deleteTopic(row.group_id, row.topic_id); }
      catch (e) { this.log(`desk: couldn't delete stale topic ${row.topic_id}: ${errText(e)}`); continue; }
      this.state.clearTopic(row.id);
      swept++;
    }
    if (swept) this.log(`desk: swept ${swept} stale topic(s)`);
    return swept;
  }

  // ---- Telegram updates from groups ----
  /** Every group update the bot's poll loop sees. Updates are handled one at a time in the
   * order they arrive; the returned promise settles when this one is done. Never rejects. */
  onUpdate(u: DeskUpdate): Promise<void> {
    if (this.queuedUpdates >= this.lim.queuedUpdates) {
      const now = Date.now();
      if (now - (this.limitLogAt.get("updates") ?? 0) >= 60_000) { this.limitLogAt.set("updates", now); this.log(`desk: limit reached (updates): ${this.lim.queuedUpdates} group updates waiting; dropping new ones`); }
      return Promise.resolve();
    }
    this.queuedUpdates++;
    const run = this.updates.then(() => this.route(u)).catch((e) => this.log(`desk: update failed: ${errText(e)}`)).finally(() => { this.queuedUpdates--; });
    this.updates = run;
    return run;
  }

  private logOnce(set: Set<string>, key: string, message: string): void {
    if (set.has(key)) return;
    if (set.size >= MEMORY_KEEP) set.clear();
    set.add(key);
    this.log(message);
  }

  private async route(u: DeskUpdate): Promise<void> {
    const chat = String(u.chatId);
    if (String(u.fromId) !== this.opts.ownerId) {
      if (u.kind === "callback") await this.tg.answerCallback(u.id).catch(() => undefined);
      // Bot messages aren't readers: the session's own replies to a topic echo back as updates
      // from this bot, and posts "as the group" arrive from GroupAnonymousBot. Treating those as
      // intruders turned the desk off on its own confirmation message.
      else if (u.fromIsBot || u.senderChat) return;
      const who = String(u.fromId ?? "unknown");
      this.logOnce(this.loggedSenders, who, `desk: ignored a group update from user ${who} (only the owner's count)`);
      // Never relayed, but it means someone else can read the desk group.
      if (chat === this.state.group()) await this.privacyBreach(chat, `a message from user ${who}`);
      return;
    }
    if (u.kind === "message" && u.newMembers && chat === this.state.group()) {
      const count = await this.tg.getChatMemberCount(chat).catch(() => 3);
      if (count > 2) await this.privacyBreach(chat, `the group has ${count} members`);
      return;
    }
    if (u.kind === "message") {
      // The owner's account, but not the owner's words, or not as themselves: never relayed.
      if (u.senderChat || u.fromIsBot) { this.logOnce(this.loggedSenders, `as-chat:${chat}`, `desk: ignored a message posted as a chat or by a bot in ${chat}`); return; }
      if (u.edited) return;
      if (u.forwarded || u.viaBot) {
        const thread = u.isTopic ? u.threadId : undefined;
        if (chat !== this.state.group()) return;
        const key = `${chat}:${thread ?? "general"}`;
        if (Date.now() - (this.noticeAt.get(key) ?? 0) < NOTICE_EVERY_MS) return;
        if (this.noticeAt.size >= MEMORY_KEEP) for (const [k, t] of this.noticeAt) if (Date.now() - t >= NOTICE_EVERY_MS) this.noticeAt.delete(k);
        if (this.noticeAt.size >= MEMORY_KEEP) this.noticeAt.clear();
        this.noticeAt.set(key, Date.now());
        await this.post(chat, thread, FORWARD_TEXT);
        return;
      }
    }
    if (u.kind === "message" && u.text && DESK_HERE.test(u.text)) { await this.deskHere(chat, u.isTopic ? u.threadId : undefined); return; }
    const group = this.state.group();
    if (chat !== group) {
      if (u.kind === "callback") await this.tg.answerCallback(u.id).catch(() => undefined);
      else void this.wrongGroupHint(chat);
      this.logOnce(this.loggedChats, chat, `desk: ignoring group ${chat} (not the desk group; /desk_here there to make it one)`);
      return;
    }
    if (u.kind === "callback") {
      const m = PERMISSION_DATA.exec(u.data ?? "");
      if (!m) { await this.tg.answerCallback(u.id).catch(() => undefined); return; }
      await this.verdict(Number(m[1]), m[3], m[4] === "y", { callbackId: u.id, messageId: u.messageId, text: u.text, pid: Number(m[2]) });
      return;
    }
    const thread = u.isTopic ? u.threadId : undefined;
    const text = u.text;
    if (!text) {
      if (u.media && thread !== undefined) await this.post(chat, thread, TEXT_ONLY);
      return;
    }
    if (DESK_OFF.test(text)) {
      this.state.setGroup(undefined);
      await this.post(chat, thread, "Desk is off: new sessions won't open topics and nothing here reaches a session. Send /desk_here in a group to turn it back on.");
      return;
    }
    if (thread === undefined) { await this.post(chat, undefined, GENERAL_HINT); return; }
    const row = this.state.byTopic(chat, thread);
    const conn = row ? this.bySession.get(row.id) : undefined;
    if (!row || !conn || conn.ended) {
      await this.post(chat, thread, row?.status === "live" ? RECONNECTING_TEXT : NO_SESSION_TEXT);
      return;
    }
    // A message from before this session started was meant for an earlier one (delivered late).
    const started = row.started_at ? Date.parse(`${row.started_at.replace(" ", "T")}Z`) : NaN;
    if (u.date !== undefined && u.date * 1000 < started - CLOCK_SLACK_MS) { await this.post(chat, thread, BEFORE_SESSION); return; }
    const v = VERDICT_TEXT.exec(text);
    if (v) { await this.verdict(row.id, v[2].toLowerCase(), v[1].toLowerCase().startsWith("y"), { threadId: thread }); return; }
    this.write(conn, { type: "message", text, message_id: u.messageId });
    void this.tg.typing(chat, thread).catch(() => undefined);
  }

  /** A permission answer (button or typed), relayed to the session it belongs to, once, and only
   * for a prompt this session raised that was shown in full in its topic. A tap must come from
   * that very message. Anything else is refused here: an approval never takes effect for
   * something the owner wasn't shown. */
  private async verdict(sessionId: number, requestId: string, allow: boolean, via: { callbackId?: string; messageId?: number; text?: string; threadId?: number; pid?: number }): Promise<void> {
    const group = this.state.group()!;
    const conn = this.bySession.get(sessionId);
    const say = async (t: string) => {
      if (via.callbackId) await this.tg.answerCallback(via.callbackId, t).catch(() => undefined);
      else await this.post(group, via.threadId, t);
    };
    const stale = async (t: string, note: string) => {
      await say(t);
      if (via.messageId && via.text) await this.tg.edit(group, via.messageId, `${via.text}\n\n${note}`).catch(() => undefined);
    };
    if (!conn || conn.ended) { await stale("This session has ended.", "Session ended before an answer."); return; }
    if (via.pid !== undefined && conn.hello?.pid !== via.pid) { await stale(EARLIER_SESSION, "Session ended before an answer."); return; }
    if (conn.answered.has(requestId)) { await say("Already answered."); return; }
    const p = conn.pending.get(requestId);
    if (!p || (via.callbackId !== undefined && via.messageId !== p.messageId)) {
      await say(NO_PROMPT);
      if (via.callbackId && via.messageId && via.text) await this.tg.edit(group, via.messageId, `${via.text}\n\nCan't be answered here any more; answer it in the terminal.`).catch(() => undefined);
      return;
    }
    conn.answered.add(requestId);
    if (conn.answered.size > ANSWERED_KEEP) conn.answered.delete(conn.answered.values().next().value!);
    this.write(conn, { type: "verdict", request_id: requestId, behavior: allow ? "allow" : "deny" });
    const label = allow ? "✅ Allowed" : "❌ Denied";
    if (via.callbackId) await this.tg.answerCallback(via.callbackId, label).catch(() => undefined);
    conn.pending.delete(requestId);
    await this.tg.edit(group, p.messageId, `${p.text}\n\n${label}`).catch((e) => this.log(`desk: couldn't mark a prompt answered: ${errText(e)}`));
  }

  /** /desk_here from the owner: make this group the desk group if it's ready and private, else
   * say what's missing. Anyone else in the group could read every reply and permission preview. */
  private async deskHere(chatId: string, threadId?: number): Promise<void> {
    const missing: string[] = [];
    try {
      const chat = await this.tg.getChat(chatId);
      if (chat.username) missing.push("This group is public (it has a @username). Make it private: anyone who can open it could read your sessions.");
      if (!chat.is_forum) missing.push("Topics are off. Turn on Topics in the group's settings.");
      const count = await this.tg.getChatMemberCount(chatId);
      if (count > 2) missing.push(`This group has ${count} members. Use a group with just you and the bot: anyone in it can read your sessions and permission prompts.`);
      const me = await this.tg.getMe();
      const member = await this.tg.getChatMember(chatId, me.id);
      if (member.status !== "administrator" && member.status !== "creator") missing.push("The bot isn't an admin here. Make it an admin with the Manage topics right.");
      else if (member.status === "administrator" && !member.can_manage_topics) missing.push("The bot can't manage topics. Turn on Manage topics in its admin rights.");
    } catch (e) { missing.push(`Couldn't check this group: ${clip(errText(e), 200)}`); }
    if (missing.length) {
      await this.post(chatId, threadId, `Not set up yet:\n• ${missing.join("\n• ")}\n\nThen send /desk_here again.`);
      return;
    }
    this.state.setGroup(chatId);
    this.log(`desk: group ${chatId} is now the desk group`);
    await this.post(chatId, threadId, "✅ This is the desk group now. In any Claude session started through claude-telegram, /desk opens its topic here.");
    // Every live session: a new topic if it was elsewhere, otherwise a fresh welcome, which also
    // clears an error a session got while desk was off.
    for (const c of this.conns) if (c.hello && !c.ended) void this.lock(c.hello.cwd, () => this.attach(c));
  }
}
