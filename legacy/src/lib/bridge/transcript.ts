/**
 * Reading Claude Code session transcripts (`<projects>/<encoded-cwd>/<id>.jsonl`).
 *
 * The format is undocumented. What this relies on, as observed in 2.1.28x:
 *  - A prompt typed at the terminal is a `type:"user"` record with
 *    `origin.kind === "human"` (older builds: no `origin`, not `isMeta`).
 *    Peer messages and task notifications carry other origins or `isMeta`.
 *  - Assistant output arrives as one `type:"assistant"` record per content
 *    block; `text` blocks are the reply, `thinking`/`tool_use` are noise.
 *  - The end of a turn is a `type:"system", subtype:"turn_duration"` record.
 *    An interrupted turn instead gets a user record "[Request interrupted…".
 *  - Titles: `custom-title` (set by /rename) wins over the generated `ai-title`.
 */

import { open, stat } from "node:fs/promises";

export type Rec = Record<string, any>;

/** Parse complete JSONL lines; a trailing partial line is left unconsumed. */
export function parseChunk(buf: string): { records: Rec[]; consumed: number } {
  const records: Rec[] = [];
  const lastNl = buf.lastIndexOf("\n");
  if (lastNl < 0) return { records, consumed: 0 };
  for (const line of buf.slice(0, lastNl).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // a corrupt line is skipped, not fatal
    }
  }
  return { records, consumed: Buffer.byteLength(buf.slice(0, lastNl + 1)) };
}

function userText(rec: Rec): string | null {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return null;
    const t = c
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    return t || null;
  }
  return null;
}

export function isInterrupt(rec: Rec): boolean {
  if (rec.type !== "user") return false;
  const t = userText(rec);
  return !!t && t.startsWith("[Request interrupted");
}

/** A prompt a person typed (as opposed to tool results, peers, reminders). */
export function isHumanPrompt(rec: Rec): boolean {
  if (rec.type !== "user" || rec.isSidechain || rec.isMeta) return false;
  if (rec.origin && rec.origin.kind !== "human") return false;
  const t = userText(rec);
  return !!t && !isInterrupt(rec);
}

export function isTurnEnd(rec: Rec): boolean {
  return (rec.type === "system" && rec.subtype === "turn_duration") || isInterrupt(rec);
}

/** Visible text blocks of an assistant record (thinking and tools dropped). */
export function assistantTexts(rec: Rec): string[] {
  if (rec.type !== "assistant" || rec.isSidechain) return [];
  const c = rec.message?.content;
  if (!Array.isArray(c)) return [];
  return c
    .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b) => b.text as string);
}

/**
 * Follows one turn through a stream of records: waits for the prompt we sent,
 * then yields assistant text until the turn-end marker.
 */
export class TurnTracker {
  started = false;
  ended = false;
  /** Seen an assistant record with stop_reason end_turn since the prompt. */
  sawEndTurn = false;

  feed(records: Rec[]): string[] {
    const out: string[] = [];
    for (const rec of records) {
      if (this.ended) break;
      if (!this.started) {
        if (isHumanPrompt(rec)) this.started = true;
        continue;
      }
      if (isTurnEnd(rec)) {
        this.ended = true;
        break;
      }
      out.push(...assistantTexts(rec));
      if (rec.type === "assistant" && !rec.isSidechain) {
        this.sawEndTurn = rec.message?.stop_reason === "end_turn";
      }
    }
    return out;
  }
}

/**
 * Busy/idle from the transcript alone: the last conversational record decides.
 * Used as a fallback when the process status file is missing or unknown.
 */
export function transcriptBusy(records: Rec[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.isSidechain) continue;
    if (isTurnEnd(r)) return false;
    if (r.type === "assistant") return r.message?.stop_reason !== "end_turn";
    if (r.type === "user") return true;
  }
  return false;
}

export interface TranscriptSummary {
  title: string | null;
  firstPrompt: string | null;
  recentPrompts: string[];
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Title + first prompt + last three prompts, all clipped. */
export function summarize(records: Rec[], maxLen = 160): TranscriptSummary {
  let custom: string | null = null;
  let ai: string | null = null;
  const prompts: string[] = [];
  let lastPrompt: string | null = null;
  for (const r of records) {
    if (r.type === "last-prompt" && typeof r.lastPrompt === "string") lastPrompt = r.lastPrompt;
    if (r.type === "custom-title" && r.customTitle) custom = String(r.customTitle);
    if (r.type === "ai-title" && r.aiTitle) ai = String(r.aiTitle);
    if (isHumanPrompt(r)) {
      const t = userText(r)!;
      // slash-command wrappers and other harness tags aren't useful context
      if (!t.trimStart().startsWith("<")) prompts.push(clip(t, maxLen));
    }
  }
  // Long tool-heavy sessions can push every prompt out of the tail window;
  // the `last-prompt` bookkeeping record still names the latest one.
  if (lastPrompt && !lastPrompt.trimStart().startsWith("<")) {
    const lp = clip(lastPrompt, maxLen);
    if (prompts.at(-1) !== lp) prompts.push(lp);
  }
  return {
    title: custom ?? ai,
    firstPrompt: prompts[0] ?? null,
    recentPrompts: prompts.slice(1).slice(-3),
  };
}

/**
 * Records from the head and tail of a (possibly multi-MB) transcript, without
 * reading the middle. Enough for a summary: the first prompt lives at the top,
 * titles and recent prompts at the bottom.
 */
export async function readHeadTail(
  file: string,
  headBytes = 256 * 1024,
  tailBytes = 1024 * 1024,
): Promise<Rec[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const read = async (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead).toString("utf8");
    };
    if (size <= headBytes + tailBytes) return parseChunk(await read(0, size) + "\n").records;
    const head = parseChunk(await read(0, headBytes)).records;
    let tail = await read(size - tailBytes, tailBytes);
    tail = tail.slice(tail.indexOf("\n") + 1); // drop the partial first line
    return [...head, ...parseChunk(tail + "\n").records];
  } finally {
    await fh.close();
  }
}

/** Read everything appended since `offset`. Returns records + the new offset. */
export async function readFrom(
  file: string,
  offset: number,
): Promise<{ records: Rec[]; offset: number }> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { records: [], offset };
  }
  if (size <= offset) return { records: [], offset };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    const { records, consumed } = parseChunk(buf.subarray(0, bytesRead).toString("utf8"));
    return { records, offset: offset + consumed };
  } finally {
    await fh.close();
  }
}
