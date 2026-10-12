/** The channel server for one Claude Code session (`claude-telegram desk-channel`): a stdio
 * MCP server that Claude Code loads as a channel (research preview, see
 * https://code.claude.com/docs/en/channels-reference). It connects to the daemon's
 * desk socket and relays: the owner's Telegram messages → this session, replies and
 * permission prompts → the session's topic, and permission verdicts back. */
import { createConnection, type Socket } from "node:net";
import { lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { DaemonMessage, decode, encode, LineReader, MAX_LINE_BYTES, MAX_TEXT_BYTES, REQUEST_ID, type ChannelMessage } from "./protocol.js";

/** Whether a message fits in one protocol line once encoded (JSON escaping can grow text). */
const fits = (m: ChannelMessage) => Buffer.byteLength(encode(m), "utf8") <= MAX_LINE_BYTES;

export const CHANNEL_NAME = "claude-telegram";
export const ENV_GUARD = "CLAUDE_TELEGRAM_DESK";
export const REFUSAL = `claude-telegram desk-channel: not starting, because ${ENV_GUARD}=1 isn't set. This server only runs inside a session started with \`claude-telegram code\`, which sets it.\n`;

export const INSTRUCTIONS = [
  `The owner can also talk to this session from their phone. Their messages arrive as <channel source="${CHANNEL_NAME}" message_id="...">text</channel>; claude-telegram only passes on text the owner wrote themselves, from their own Telegram account (forwarded messages are never passed on).`,
  "They read Telegram, not this terminal: anything you want them to see must go through the reply tool. Your normal transcript output never reaches them.",
  "This session has its own Telegram topic, so reply takes just the text. Use plain text (no Markdown rendering); long replies are split automatically.",
  "Answer a channel message with reply, even briefly, so they know you got it.",
].join("\n");

/** Pending outbound messages kept while the daemon is unreachable. */
const QUEUE_MAX = 50;
const OPEN_KEEP = 100;

type Hello = Extract<ChannelMessage, { type: "hello" }>;

export interface LinkHandlers {
  onMessage(text: string, messageId: number): void;
  onVerdict(requestId: string, behavior: "allow" | "deny"): void;
  onWelcome?(sessionId: number, topicName: string): void;
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
  /** The daemon's last error since connecting (e.g. no desk group): replies would go nowhere. */
  lastError?: string;
  welcomed = false;

  constructor(private socketPath: string, private hello: Hello, private h: LinkHandlers, private log: (m: string) => void = () => {},
    private backoff = { min: 250, max: 5000 }) {
    this.delay = backoff.min;
  }

  get isConnected(): boolean { return this.connected; }

  start(): void { this.connect(); }

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
    else if (m.type === "error") { this.lastError = m.reason; this.log(`daemon: ${m.reason}`); }
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

  /** Say bye (if connected) and stop reconnecting. */
  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    const sock = this.sock;
    if (!sock || !this.connected) { sock?.destroy(); return; }
    await new Promise<void>((r) => {
      const t = setTimeout(() => { sock.destroy(); r(); }, 1000);
      sock.once("close", () => { clearTimeout(t); r(); });
      sock.end(encode({ type: "bye" }));
    });
  }
}

const PermissionRequest = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }).passthrough(),
});

export interface DeskChannel { server: Server; link: DaemonLink; close(): Promise<void> }

/** Build the MCP server and the daemon link, and connect the server to `transport`. */
export async function startDeskChannel(o: { socketPath: string; hello: Hello; transport: Transport; log?: (m: string) => void; backoff?: { min: number; max: number } }): Promise<DeskChannel> {
  const log = o.log ?? (() => {});
  const server = new Server({ name: CHANNEL_NAME, version: "1.0.0" }, {
    capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} }, tools: {} },
    instructions: INSTRUCTIONS,
  });
  /** Permission requests this session really made: a verdict for any other id is dropped here. */
  const open = new Set<string>();
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
  }, log, o.backoff);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "reply",
      description: "Send a message to the owner in this session's Telegram topic. Plain text; long text is split automatically.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "The message" } }, required: ["text"] },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
    if (req.params.name !== "reply") return fail(`unknown tool: ${req.params.name}`);
    const text = (req.params.arguments as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim()) return fail("reply needs non-empty text");
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES || !fits({ type: "reply", text })) return fail(`That's too long to send in one piece (${MAX_TEXT_BYTES / 1024} KB at most); send it in parts.`);
    if (link.isConnected && link.lastError) return fail(`Not sent: ${link.lastError}`);
    const r = link.send({ type: "reply", text });
    if (r === "dropped") return fail("Not sent: the claude-telegram daemon isn't reachable and too many messages are already waiting.");
    return { content: [{ type: "text" as const, text: r === "sent" ? "sent" : "queued: the claude-telegram daemon isn't reachable right now; this goes out when it's back" }] };
  });
  server.setNotificationHandler(PermissionRequest, async ({ params }) => {
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
  link.start();
  return { server, link, close: async () => { await link.close(); await server.close().catch(() => undefined); } };
}

/** The git branch of a folder, if it's in a repo. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const b = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return b && b !== "HEAD" ? b.slice(0, 256) : undefined;
  } catch { return undefined; }
}

/** `claude-telegram desk-channel`: refuses without CLAUDE_TELEGRAM_DESK=1; otherwise serves on stdio until
 * Claude Code closes it. Returns the exit code. */
export async function runDeskChannel(socketPath: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env[ENV_GUARD] !== "1") { process.stderr.write(REFUSAL); return 1; }
  const log = (m: string) => process.stderr.write(`claude-telegram desk-channel: ${m}\n`);
  process.on("unhandledRejection", (e) => log(`unhandled rejection: ${String(e)}`));
  // A half-working channel is worse than a failed one: Claude Code shows the failure.
  process.on("uncaughtException", (e) => { log(`uncaught exception: ${String(e)}`); process.exit(1); });
  // Claude Code starts stdio servers in the project folder and sets CLAUDE_PROJECT_DIR.
  const cwd = resolve(env.CLAUDE_PROJECT_DIR || process.cwd());
  const hello: Hello = { type: "hello", cwd, pid: process.pid, title: (basename(cwd) || cwd).slice(0, 256), branch: gitBranch(cwd) };
  const ch = await startDeskChannel({ socketPath, hello, transport: new StdioServerTransport(), log });
  // When Claude Code exits, stdin closes: say bye so the topic closes, then exit.
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
