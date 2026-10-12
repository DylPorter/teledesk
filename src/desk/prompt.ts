/** How a permission prompt is shown in Telegram. Claude Code's description and input preview
 * are untrusted display text. The input preview is JSON-shaped ({ "key": value, … }), so it is
 * shown field by field, nested fields included, and every field keeps its start and its end;
 * only a long field's middle is hidden. Nothing that can't be shown that way is shown at all:
 * the caller makes such a prompt answerable in the terminal only. */
import { elideMiddle, headOf, oneLine } from "./protocol.js";

/** Under Telegram's 4096-character cap per message. */
export const CHUNK = 4000;
export const FIELD_HEAD = 600;
export const FIELD_TAIL = 600;
const MAX_FIELDS = 40;
const MAX_LABEL = 80;
const MAX_TOOL = 200;
const MAX_MESSAGES = 6;

/** Control characters become spaces; direction overrides, zero-width and other invisible
 * characters go, so nothing can reorder or hide what's shown. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[؜​-‏‪-‮⁠-⁩﻿]/g;
export function cleanText(t: string): string {
  return oneLine(t.replace(CONTROL, " ").replace(INVISIBLE, ""));
}

const elide = (t: string) => elideMiddle(t, FIELD_HEAD, FIELD_TAIL);

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

/** The prompt as messages (the buttons go on the last), or undefined when it can't be shown
 * faithfully: too many or too long fields, an unparseable preview that would need cutting, or
 * more messages than is reasonable. */
export function promptMessages(tool: string, description: string, preview: string, requestId: string): string[] | undefined {
  const name = cleanText(tool);
  if (!name || name.length > MAX_TOOL) return undefined;
  const head = `🔐 Permission: ${name}`;
  const lines = [head, `What: ${elide(cleanText(description)) || "(no description)"}`];
  const fields = previewFields(preview);
  if (fields === undefined) {
    const t = cleanText(preview);
    if (t) {
      if (elide(t) !== t) return undefined; // can't tell its fields apart, so can't cut it safely
      lines.push(`Input: ${t}`);
    }
  } else {
    if (fields.length > MAX_FIELDS) return undefined;
    if (fields.length) lines.push("Input:");
    for (const f of fields) {
      const label = cleanText(f.label);
      if (label.length > MAX_LABEL) return undefined;
      lines.push(`• ${label || "(value)"}: ${elide(cleanText(f.value))}`);
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
