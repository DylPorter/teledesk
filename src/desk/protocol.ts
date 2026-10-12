/** The desk socket protocol: JSON lines between a session's channel server
 * (`desk-channel`, one per Claude Code session) and the router in the daemon.
 * Every line is validated on both ends; sizes are bounded. */
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

/** Largest text (UTF-8 bytes) carried by one message. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** Largest line accepted. JSON escaping can grow text, so this is a few times MAX_TEXT_BYTES. */
export const MAX_LINE_BYTES = 512 * 1024;
/** Claude Code's permission request ids: five lowercase letters, no 'l'. */
export const REQUEST_ID = /^[a-km-z]{5}$/;
/** A typed verdict: "yes abcde" / "no abcde" (from the channels reference). */
export const VERDICT_TEXT = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const text = (max = MAX_TEXT_BYTES) => z.string().refine((s) => Buffer.byteLength(s, "utf8") <= max, `longer than ${max} bytes`);
const short = (max: number) => z.string().max(max);
const requestId = z.string().regex(REQUEST_ID);

export const ChannelMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), cwd: z.string().min(1).max(4096), pid: z.number().int().positive(), title: short(256), branch: short(256).optional() }).strict(),
  z.object({ type: z.literal("reply"), text: text().refine((s) => s.trim().length > 0, "empty") }).strict(),
  // too_long: the request was too big to send whole; it's shown as answer-in-the-terminal only.
  z.object({ type: z.literal("permission_request"), request_id: requestId, tool_name: z.string().min(1).max(256), description: text(), input_preview: text(), too_long: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("bye") }).strict(),
]);
export type ChannelMessage = z.infer<typeof ChannelMessage>;

export const DaemonMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), session_id: z.number().int().positive(), topic_name: short(256) }).strict(),
  z.object({ type: z.literal("message"), text: text(), message_id: z.number().int() }).strict(),
  z.object({ type: z.literal("verdict"), request_id: requestId, behavior: z.enum(["allow", "deny"]) }).strict(),
  z.object({ type: z.literal("error"), reason: short(1024) }).strict(),
]);
export type DaemonMessage = z.infer<typeof DaemonMessage>;

export function encode(m: ChannelMessage | DaemonMessage): string {
  return JSON.stringify(m) + "\n";
}

/** Parse one line with a schema; undefined if it isn't JSON or doesn't match. */
export function decode<T>(schema: z.ZodType<T>, line: string): T | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  const r = schema.safeParse(raw);
  return r.success ? r.data : undefined;
}

/** Splits a byte stream into lines. Returns false once a line grows past `max` bytes
 * (the caller should drop the connection: the peer isn't speaking the protocol). */
export class LineReader {
  private buf = "";
  /** Keeps a multi-byte character split across chunks whole. */
  private dec = new StringDecoder("utf8");
  constructor(private onLine: (line: string) => void, private max = MAX_LINE_BYTES) {}
  push(chunk: Buffer | string): boolean {
    this.buf += typeof chunk === "string" ? chunk : this.dec.write(chunk);
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (Buffer.byteLength(line, "utf8") > this.max) return false;
      if (line.trim()) this.onLine(line);
    }
    return Buffer.byteLength(this.buf, "utf8") <= this.max;
  }
}

/** Text shown on one line: whitespace runs (newlines included) folded to a space. */
export const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The first n UTF-16 units of t, one fewer if the cut would split a surrogate pair. */
export function headOf(t: string, n: number): string {
  if (n <= 0) return "";
  if (t.length <= n) return t;
  return isHigh(t.charCodeAt(n - 1)) ? t.slice(0, n - 1) : t.slice(0, n);
}

/** The last n UTF-16 units of t, one fewer if the cut would split a surrogate pair. */
export function tailOf(t: string, n: number): string {
  if (n <= 0) return "";
  if (t.length <= n) return t;
  const start = t.length - n;
  return isLow(t.charCodeAt(start)) ? t.slice(start + 1) : t.slice(start);
}

/** Trim to at most n characters, marking the cut (for names and labels, never for anything approved). */
export function clip(t: string, n: number): string {
  return t.length <= n ? t : `${headOf(t, Math.max(0, n - 1))}…`;
}

/** Keep the start and the end, hide the middle: the end of a long command is what matters most
 * when approving it, so it's never cut. */
export function elideMiddle(t: string, head = 1200, tail = 1200): string {
  if (t.length <= head + tail + 40) return t;
  const h = headOf(t, head), e = tailOf(t, tail);
  return `${h} … ${t.length - h.length - e.length} chars hidden … ${e}`;
}
