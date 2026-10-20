/** The channel server for one Claude Code session (`teledesk desk-channel`): a stdio
 * MCP server that Claude Code loads as a channel (research preview, see
 * https://code.claude.com/docs/en/channels-reference). It connects to the daemon's
 * desk socket and relays: the owner's Telegram messages → this session, permission
 * prompts → the session's topic, and permission verdicts back. What the phone *reads*
 * never passes through this server: the session's hooks mirror that as protocol `mirror`
 * lines on their own. The model has no outbound text path to the topic — by design. */
import { createConnection, type Socket } from "node:net";
import { lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { DaemonMessage, decode, encode, LineReader, MAX_LINE_BYTES, MAX_TEXT_BYTES, MIRROR_TOKEN, REQUEST_ID, type ChannelMessage } from "./protocol.js";

/** Whether a message fits in one protocol line once encoded (JSON escaping can grow text). */
const fits = (m: ChannelMessage) => Buffer.byteLength(encode(m), "utf8") <= MAX_LINE_BYTES;

export const CHANNEL_NAME = "teledesk";
export const ENV_GUARD = "TELEDESK";
/** Per-spawn secret the launcher puts in the session's env so mirror hook processes can be
 * tied back to this session. Lives here, not in launcher.ts, because launcher imports this. */
export const ENV_MIRROR = "TELEDESK_MIRROR";
export const REFUSAL = `teledesk desk-channel: not starting, because ${ENV_GUARD}=1 isn't set. This server only runs inside a session started with \`teledesk code\`, which sets it.\n`;

/** Exactly one sentence, and no outbound guidance of any kind: the desk is a wiretap, the
 * model chooses nothing about what the phone sees, so it gets nothing to act on about it. */
export const INSTRUCTIONS =
  "The owner can open a Telegram topic for this session with /desk (the desk_on tool) and hide it with /desk off (desk_off).";

/** Pending outbound messages kept while the daemon is unreachable. */
const QUEUE_MAX = 50;
const OPEN_KEEP = 100;

type Hello = Extract<ChannelMessage, { type: "hello" }>;

export interface LinkHandlers {
  onMessage(text: string, messageId: number): void;
  onVerdict(requestId: string, behavior: "allow" | "deny"): void;
  onWelcome?(sessionId: number, topicName: string): void;
  onError?(reason: string): void;
}

/** The socket to the daemon: reconnects with backoff while it's down, says hello on every
 * connect, and holds a bounded queue of outbound messages until it's back. */
export class DaemonLink {
  private sock?: Socket;
  private connected = false;
  private closing = false;
  private delay: number;
  private timer?: NodeJS.Timeout;
  private queue: ChannelMessage[] = [];
  private warned = false;
  /** The daemon's last error since connecting (e.g. no desk group): prompts would go nowhere. */
  lastError?: string;
  welcomed = false;

  constructor(private socketPath: string, private hello: Hello, private h: LinkHandlers, private log: (m: string) => void = () => {},
    private backoff = { min: 250, max: 5000 }) {
    this.delay = backoff.min;
  }

  get isConnected(): boolean { return this.connected; }

  start(): void { this.closing = false; this.delay = this.backoff.min; this.connect(); }

  /** Try again later, backing off while the daemon stays away. */
  private retry(): void {
    if (this.closing) return;
    this.timer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.backoff.max);
  }

  private connect(): void {
    if (this.closing) return;
    // Only a socket this user owns: anything else at the path could be someone posing as the daemon.
    let st;
    try { st = lstatSync(this.socketPath); } catch { this.retry(); return; }
    const uid = process.getuid?.();
    if (!st.isSocket() || (uid !== undefined && st.uid !== uid)) {
      if (!this.warned) { this.warned = true; this.log(`${this.socketPath} isn't a socket owned by this user; not connecting to it`); }
      this.retry();
      return;
    }
    const sock = createConnection(this.socketPath);
    this.sock = sock;
    const reader = new LineReader((line) => this.onLine(line));
    sock.on("connect", () => {
      this.connected = true;
      this.delay = this.backoff.min;
      this.lastError = undefined;
      this.welcomed = false;
      sock.write(encode(this.hello));
      const q = this.queue;
      this.queue = [];
      for (const m of q) sock.write(encode(m));
    });
    sock.on("data", (d) => { if (!reader.push(d)) sock.destroy(); });
    sock.on("error", () => { /* close follows */ });
    sock.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.welcomed = false;
      if (this.sock === sock) this.sock = undefined;
      if (this.closing) return;
      if (was) this.log("lost the connection to the daemon; reconnecting");
      this.retry();
    });
  }

  private onLine(line: string): void {
    const m = decode(DaemonMessage, line);
    if (!m) { this.log("ignored a malformed message from the daemon"); return; }
    if (m.type === "welcome") { this.welcomed = true; this.lastError = undefined; this.h.onWelcome?.(m.session_id, m.topic_name); }
    else if (m.type === "error") { this.lastError = m.reason; this.log(`daemon: ${m.reason}`); this.h.onError?.(m.reason); }
    else if (m.type === "message") this.h.onMessage(m.text, m.message_id);
    else this.h.onVerdict(m.request_id, m.behavior);
  }

  /** Send now, or queue while disconnected. "dropped" when the queue is full. */
  send(m: ChannelMessage): "sent" | "queued" | "dropped" {
    if (this.connected && this.sock) { this.sock.write(encode(m)); return "sent"; }
    if (this.queue.length >= QUEUE_MAX) return "dropped";
    this.queue.push(m);
    return "queued";
  }

  /** Say bye (if connected) and stop reconnecting; `start()` can bring the link back later
   * (desk_off then desk_on), and `close()` at process exit is the same thing permanently.
   * `hide: true` marks the bye as an explicit /desk off: the daemon quietly takes the topic
   * out of the list until /desk reopens it. A plain bye leaves the topic exactly as it is. */
  async detach(hide?: boolean): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    const sock = this.sock;
    this.queue = [];
    if (!sock || !this.connected) { sock?.destroy(); this.sock = undefined; this.connected = false; this.welcomed = false; return; }
    await new Promise<void>((r) => {
      const t = setTimeout(() => { sock.destroy(); r(); }, 1000);
      sock.once("close", () => { clearTimeout(t); r(); });
      sock.end(encode({ type: "bye", ...(hide ? { hide: true } : {}) }));
    });
    this.connected = false;
    this.welcomed = false;
  }

  /** Say bye (if connected) and stop reconnecting; `hide` is for /desk off only. */
  async close(hide?: boolean): Promise<void> { await this.detach(hide); }
}

const PermissionRequest = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }).passthrough(),
});

export interface DeskChannel { server: Server; link: DaemonLink; close(hide?: boolean): Promise<void> }

/** What desk_on resolves to: the topic, the daemon's reason there isn't one, or no daemon. */
type Activation = { kind: "welcome"; topic: string } | { kind: "error"; reason: string } | { kind: "unreachable" };

/** How long desk_on waits for the daemon's welcome or error before reporting "unreachable". */
const ACTIVATE_TIMEOUT_MS = 15_000;

/** Build the MCP server and the daemon link, and connect the server to `transport`. The link
 * stays dormant (never dials the daemon, no topic) until the desk_on tool — what the owner's
 * /desk runs — unless `autostart` is set. Dormant means: permission prompts left to the
 * terminal and nothing reaches Telegram. */
export async function startDeskChannel(o: { socketPath: string; hello: Hello; transport: Transport; log?: (m: string) => void; backoff?: { min: number; max: number }; autostart?: boolean }): Promise<DeskChannel> {
  const log = o.log ?? (() => {});
  const server = new Server({ name: CHANNEL_NAME, version: "1.0.0" }, {
    capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} }, tools: {} },
    instructions: INSTRUCTIONS,
  });
  /** Permission requests this session really made: a verdict for any other id is dropped here. */
  const open = new Set<string>();
  /** On from desk_on (or autostart) until desk_off: gates the link, replies and prompt relays. */
  let activated = o.autostart === true;
  let topicName: string | undefined;
  let waiters: ((r: Activation) => void)[] = [];
  const flush = (r: Activation) => { const w = waiters; waiters = []; for (const f of w) f(r); };
  const link = new DaemonLink(o.socketPath, o.hello, {
    onMessage: (text, messageId) => {
      server.notification({ method: "notifications/claude/channel", params: { content: text, meta: { message_id: String(messageId) } } })
        .catch((e) => log(`couldn't deliver a message to Claude Code: ${(e as Error).message}`));
    },
    onVerdict: (requestId, behavior) => {
      if (!open.delete(requestId)) { log(`ignored a verdict for unknown request ${requestId}`); return; }
      server.notification({ method: "notifications/claude/channel/permission", params: { request_id: requestId, behavior } })
        .catch((e) => log(`couldn't deliver a verdict: ${(e as Error).message}`));
    },
    onWelcome: (_sessionId, name) => { topicName = name; flush({ kind: "welcome", topic: name }); },
    onError: (reason) => flush({ kind: "error", reason }),
  }, log, o.backoff);

  /** Dial in (or reuse a live link) and wait for the daemon's welcome or error. */
  const activate = (): Promise<Activation> => {
    if (link.isConnected && link.welcomed && topicName !== undefined) return Promise.resolve({ kind: "welcome", topic: topicName });
    if (link.isConnected && link.lastError) return Promise.resolve({ kind: "error", reason: link.lastError });
    link.start();
    const answered = new Promise<Activation>((resolve) => { waiters.push(resolve); });
    const timedOut = new Promise<Activation>((resolve) => {
      const t = setTimeout(() => resolve(link.isConnected ? { kind: "error", reason: "the daemon didn't answer in time" } : { kind: "unreachable" }), ACTIVATE_TIMEOUT_MS);
      t.unref?.();
    });
    return Promise.race([answered, timedOut]);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "desk_on",
        description: "Open this session's Telegram topic so the owner can talk to it from their phone. This is what the owner's /desk runs.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "desk_off",
        description: "Stop relaying to this session's Telegram topic and quietly hide the topic from the list. This is what the owner's /desk off runs; /desk reopens the very same topic.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
    const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    if (req.params.name === "desk_on") {
      if (activated && link.welcomed && topicName !== undefined) return ok(`Desk is already on: this session's topic is "${topicName}".`);
      activated = true;
      const r = await activate();
      if (r.kind === "welcome") return ok(`Desk is on: this session's topic is "${r.topic}".`);
      if (r.kind === "unreachable") return ok("Desk is on, but the teledesk daemon isn't reachable right now; the topic opens as soon as it is.");
      return fail(`Desk couldn't open a topic: ${r.reason}`);
    }
    if (req.params.name === "desk_off") {
      if (!activated) return ok("Desk is already off.");
      activated = false;
      topicName = undefined;
      await link.detach(true);
      return ok("Desk is off: relaying stopped and permission prompts are terminal-only again. The topic is quietly hidden from the list; /desk brings the same one back.");
    }
    // The reply tool died with the mirror redesign: the model has no path to the topic.
    return fail(`unknown tool: ${req.params.name}`);
  });
  server.setNotificationHandler(PermissionRequest, async ({ params }) => {
    // Dormant: the terminal is the only place this prompt exists; there's nothing to relay.
    if (!activated) return;
    if (!REQUEST_ID.test(params.request_id)) { log(`ignored a permission request with an unexpected id`); return; }
    const tool = params.tool_name || "tool";
    const whole: ChannelMessage = { type: "permission_request", request_id: params.request_id, tool_name: tool, description: params.description, input_preview: params.input_preview };
    // Never cut a field: what can't be sent whole is sent as too long, answerable in the terminal only.
    if (Buffer.byteLength(params.description, "utf8") > MAX_TEXT_BYTES || Buffer.byteLength(params.input_preview, "utf8") > MAX_TEXT_BYTES || tool.length > 256 || !fits(whole)) {
      link.send({ type: "permission_request", request_id: params.request_id, tool_name: tool.slice(0, 200) || "tool", description: "", input_preview: "", too_long: true });
      return;
    }
    open.add(params.request_id);
    if (open.size > OPEN_KEEP) open.delete(open.values().next().value!);
    link.send(whole);
  });

  await server.connect(o.transport);
  if (activated) link.start();
  return { server, link, close: async (hide?: boolean) => { await link.close(hide); await server.close().catch(() => undefined); } };
}

/** The git branch of a folder, if it's in a repo. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const b = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return b && b !== "HEAD" ? b.slice(0, 256) : undefined;
  } catch { return undefined; }
}

/** `teledesk desk-channel`: refuses without TELEDESK=1; otherwise serves on stdio until
 * Claude Code closes it. Returns the exit code. */
export async function runDeskChannel(socketPath: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env[ENV_GUARD] !== "1") { process.stderr.write(REFUSAL); return 1; }
  const log = (m: string) => process.stderr.write(`teledesk desk-channel: ${m}\n`);
  process.on("unhandledRejection", (e) => log(`unhandled rejection: ${String(e)}`));
  // A half-working channel is worse than a failed one: Claude Code shows the failure.
  process.on("uncaughtException", (e) => { log(`uncaught exception: ${String(e)}`); process.exit(1); });
  // Claude Code starts stdio servers in the project folder and sets CLAUDE_PROJECT_DIR.
  const cwd = resolve(env.CLAUDE_PROJECT_DIR || process.cwd());
  // The launcher's per-spawn secret, carried so the daemon can tie mirror hook lines to this
  // session. Sent only when it's a real token; never logged anywhere in this process.
  const token = env[ENV_MIRROR];
  const hello: Hello = { type: "hello", cwd, pid: process.pid, title: (basename(cwd) || cwd).slice(0, 256), branch: gitBranch(cwd), ...(token && MIRROR_TOKEN.test(token) ? { mirror_token: token } : {}) };
  const ch = await startDeskChannel({ socketPath, hello, transport: new StdioServerTransport(), log });
  // When Claude Code exits, stdin closes: say a plain bye (the topic stays as it is), then exit.
  let done = false;
  const shutdown = () => {
    if (done) return;
    done = true;
    setTimeout(() => process.exit(0), 2000).unref();
    void ch.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, shutdown);
  setInterval(() => { if (process.stdin.destroyed || process.stdin.readableEnded) shutdown(); }, 5000).unref();
  return await new Promise<number>(() => { /* runs until shutdown exits the process */ });
}
