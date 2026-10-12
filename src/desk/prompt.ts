/** How a permission prompt is shown in Telegram. Claude Code's description and input preview
 * are untrusted display text. The input preview is JSON-shaped ({ "key": value, … }), so it is
 * shown field by field, nested fields included, and nothing is ever hidden: every field is shown
 * in full. A prompt that doesn't fit that way isn't shown at all: the caller makes it
 * answerable in the terminal only. */
import { headOf, oneLine } from "./protocol.js";

/** Under Telegram's 4096-character cap per message. */
export const CHUNK = 4000;
/** Longest field shown (after cleaning); Claude Code relays at most 3,500 code points per field. */
export const MAX_FIELD = 3500;
const MAX_FIELDS = 40;
const MAX_LABEL = 80;
const MAX_TOOL = 200;
export const MAX_MESSAGES = 4;
/** Claude Code's own mark where it left out the middle of a long field: such a field isn't whole. */
const CLAUDE_ELIDED = /\u22ef\s*\d+\s+code points elided\s*\u22ef/;

/** Control characters become spaces; direction overrides, zero-width and other invisible
 * characters go, so nothing can reorder or hide what's shown. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export function cleanText(t: string): string {
  return oneLine(t.replace(CONTROL, " ").replace(INVISIBLE, ""));
}

interface Field { label: string; value: string }

/** The preview's fields, flattened (a.b, a[0]); undefined if it isn't a JSON object. */
export function previewFields(preview: string): Field[] | undefined {
  const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = parse(preview);
  // Claude Code may put a bare marker where a value couldn't be serialized.
  if (v === undefined) v = parse(preview.replace(/:\s*\(value unserializable\)/g, ': "(value unserializable)"'));
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Field[] = [];
  const walk = (x: unknown, path: string): void => {
    if (out.length > MAX_FIELDS) return;
    if (x !== null && typeof x === "object") {
      const entries: [string, unknown][] = Array.isArray(x) ? x.map((y, i) => [`${path}[${i}]`, y]) : Object.entries(x).map(([k, y]) => [path ? `${path}.${k}` : k, y]);
      if (!entries.length) { out.push({ label: path, value: Array.isArray(x) ? "[]" : "{}" }); return; }
      for (const [p, y] of entries) walk(y, p);
      return;
    }
    out.push({ label: path, value: typeof x === "string" ? x : JSON.stringify(x) });
  };
  walk(v, "");
  return out;
}

/** The prompt as messages (the buttons go on the last), everything in full; or undefined when it
 * can't be shown that way: a field (or the description, or an unparseable preview) longer than
 * MAX_FIELD or already shortened by Claude Code, too many fields, a label too long, or more than
 * MAX_MESSAGES messages. */
export function promptMessages(tool: string, description: string, preview: string, requestId: string): string[] | undefined {
  const name = cleanText(tool);
  if (!name || name.length > MAX_TOOL) return undefined;
  const head = `🔐 Permission: ${name}`;
  const desc = cleanText(description);
  if (desc.length > MAX_FIELD || CLAUDE_ELIDED.test(desc)) return undefined;
  const lines = [head, `What: ${desc || "(no description)"}`];
  const fields = previewFields(preview);
  if (fields === undefined) {
    const t = cleanText(preview);
    if (t.length > MAX_FIELD || CLAUDE_ELIDED.test(t)) return undefined;
    if (t) lines.push(`Input: ${t}`);
  } else {
    if (fields.length > MAX_FIELDS) return undefined;
    if (fields.length) lines.push("Input:");
    for (const f of fields) {
      const label = cleanText(f.label);
      if (label.length > MAX_LABEL) return undefined;
      const value = cleanText(f.value);
      if (value.length > MAX_FIELD || CLAUDE_ELIDED.test(value)) return undefined;
      lines.push(`• ${label || "(value)"}: ${value}`);
    }
  }
  const foot = `Tap a button, or reply "yes ${requestId}" or "no ${requestId}".`;
  const msgs: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > CHUNK) { msgs.push(cur); cur = `${head} (continued)\n${line}`; } else cur = next;
  }
  const last = `${cur}\n\n${foot}`;
  if (last.length > CHUNK) msgs.push(cur, `${head} (continued)\n\n${foot}`); else msgs.push(last);
  return msgs.length > MAX_MESSAGES ? undefined : msgs;
}

export const tooLongText = (tool: string) =>
  `🔐 Claude is asking to use ${headOf(cleanText(tool), MAX_TOOL) || "a tool"}. This prompt is too long to show safely — answer it in the terminal.`;
