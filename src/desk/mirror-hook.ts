/** `teledesk mirror-hook` — the entrypoint Claude Code's hooks run: hook JSON in on stdin,
 * protocol mirror lines out to the daemon's desk socket, exit 0 whatever happens. The hook
 * must never disturb the session it observes, so every failure path (bad JSON, unknown event,
 * dead daemon, EPIPE, timeout) is silent and returns 0; nothing is ever written to stdout or
 * stderr — the session token in the env is a secret, and hook noise lands in the transcript.
 * Shell-level backgrounding of tool-event hooks is the installer's job (spike (c) + Task 9);
 * this CLI does one synchronous pass and stays dependency-light (protocol only). */
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { clip, clipBytes, encode, MAX_TEXT_BYTES, MIRROR_TOKEN, oneLine, type MirrorMessage } from "./protocol.js";

/** Hard cap on one hook run: connecting, writing and draining all live inside it. */
export const MIRROR_TIMEOUT_MS = 1500;

/** The launcher's per-spawn secret. ENV_MIRROR lives in channel.js, and importing that would
 * pull the MCP SDK into every hook spawn, so only the name is repeated here. */
const ENV_MIRROR = "TELEDESK_MIRROR";

/** The fields this CLI reads from the hook JSON (spike (a): the real payload carries more;
 * unknown event shapes must not break it, so everything is optional). */
export interface HookInput { hook_event_name?: string; session_id?: string; prompt?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown; transcript_path?: string; }

/** Tools the harness calls on the way to real ones (spike (d): a ToolSearch gate fronts deferred
 * MCP tools and fires its own Pre/Post events). Their events are plumbing, not conversation (ruling 7). */
const INTERNAL_TOOLS = new Set(["ToolSearch"]);

/** The owner's /desk runs this tool; its PostToolUse is the trigger for the 📜 history snapshot. */
const DESK_ON_TOOL = "mcp__teledesk__desk_on";

/** One transcript row as far as extraction cares (spike (a): the file is
 * `~/.claude/projects/<cwd-encoded>/<session_id>.jsonl`, one JSON object per line). */
interface TranscriptRow { type?: unknown; message?: { content?: unknown } }

/** JSONL → rows; malformed lines are skipped, never thrown on — a torn last line must not
 * cost the hook the rest of the turn. */
function jsonLines(transcript: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as TranscriptRow); } catch { /* skip */ }
  }
  return rows;
}

/** A turn boundary row: a `user` row whose content is the typed prompt string. Tool results
 * are also user rows but carry array content — they do not bound a turn. */
const promptOf = (r: TranscriptRow): string | undefined =>
  r.type === "user" && typeof r.message?.content === "string" ? r.message.content : undefined;

/** The string `text` of an array content's blocks, in order; blocks without one (tool_use,
 * stray values) are ignored. */
function blocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    const t = (b as { text?: unknown } | null | undefined)?.text;
    if (typeof t === "string" && t !== "") out.push(t);
  }
  return out;
}

/** Every assistant row's text blocks in rows[start, end), file order, joined "\n\n". */
function assistantText(rows: TranscriptRow[], start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    const r = rows[i]!;
    if (r.type === "assistant") parts.push(...blocksOf(r.message?.content));
  }
  return parts.join("\n\n");
}

/** The whole turn's assistant answer (a turn can span several assistant messages — the reason
 * the transcript, not the hook's last_assistant_message field, is the primary source), or
 * undefined when the turn said nothing in words. Clipped to MAX_TEXT_BYTES counted as UTF-8
 * bytes, which is what the daemon bounds: clip the units and a CJK answer decodes as oversized
 * and is dropped whole. Character cleaning is the daemon's job (Task 7's replyText), not ours. */
export function extractTurnAssistant(transcript: string): string | undefined {
  const rows = jsonLines(transcript);
  let boundary = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (promptOf(rows[i]!) !== undefined) { boundary = i + 1; break; }
  }
  const text = assistantText(rows, boundary, rows.length);
  return text ? clipBytes(text, MAX_TEXT_BYTES) : undefined;
}

/** A capped snapshot of the earlier conversation for a desk opened mid-session: the last
 * `maxTurns` completed prompt→answer pairs, rendered oldest first with 🧑/🤖 marks and
 * `---` separators, each side clipped to `perTurnChars` (characters, by pin) and the total to
 * MAX_TEXT_BYTES counted as UTF-8 bytes.
 * A pair is completed only when the prompt is followed by assistant text (the turn in
 * flight has none yet); undefined when the transcript holds no completed pair. */
export function extractHistory(transcript: string, maxTurns = 5, perTurnChars = 500): string | undefined {
  const rows = jsonLines(transcript);
  const pairs: string[] = []; // newest first, reversed when rendered
  let end = rows.length;
  for (let i = rows.length - 1; i >= 0 && pairs.length < maxTurns; i--) {
    const prompt = promptOf(rows[i]!);
    if (prompt === undefined) continue;
    const answer = assistantText(rows, i + 1, end);
    end = i;
    if (!answer) continue;
    pairs.push(`🧑 ${clip(prompt, perTurnChars)}\n\n🤖 ${clip(answer, perTurnChars)}`);
  }
  return pairs.length ? clipBytes(pairs.reverse().join("\n\n---\n\n"), MAX_TEXT_BYTES) : undefined;
}

/** Per-tool subject of a call (ruling 6: CC 2.1.304 fires the subagent tool as `Agent`;
 * `Task` is the older build's name — both are special-cased). Inputs shaped differently
 * fall back to the JSON of the whole input. */
const TOOL_START_FIELD: Record<string, string> = {
  Bash: "command", Read: "file_path", Edit: "file_path", Write: "file_path", NotebookEdit: "file_path",
  Agent: "description", Task: "description", Grep: "pattern", Glob: "pattern", WebSearch: "query",
};

export function toolStartSummary(toolName: string, input: unknown): string {
  if (input === undefined || input === null) return "";
  const field = TOOL_START_FIELD[toolName];
  const value = field ? (input as Record<string, unknown>)[field] : undefined;
  return oneLine(clip(typeof value === "string" ? value : (JSON.stringify(input) ?? ""), 200));
}

export function toolEndSummary(response: unknown): string {
  if (response === undefined || response === null) return "";
  return oneLine(clip(typeof response === "string" ? response : (JSON.stringify(response) ?? ""), 300));
}

/** The wrapper phone-injected messages arrive in (spike (e) form:
 * `<channel source="teledesk" message_id="…">text</channel>`); unwrapped text is unchanged.
 * The daemon does the cleaning (Task 7); this export is its tool. */
export function stripChannelWrapper(text: string): string {
  const stripped = text.replace(/^\s*<channel source="teledesk"[^>]*>/, "").replace(/<\/channel>\s*$/, "");
  return stripped === text ? text : stripped.trim();
}

/** Transcript JSONL as text; "" when there is none — a missing file is never an error here. */
function readTranscript(path: string | undefined): string {
  if (!path) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** PostToolUse success per spike (a): responses are per-tool and none of the observed shapes
 * carries an error marker when the call went well. Missing response, an error field, or an
 * interrupted call (Bash's flag) all read as not ok. */
function toolEndOk(response: unknown): boolean {
  if (response === undefined || response === null) return false;
  if (Array.isArray(response)) return !response.some(hasErrorField);
  if (typeof response === "object") return !hasErrorField(response);
  return true;
}
function hasErrorField(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.is_error === true || o.isError === true || o.error !== undefined || o.interrupted === true;
}

interface Extractors { extractTurnAssistant: (t: string) => string | undefined; extractHistory: (t: string) => string | undefined; }

/** Hook JSON → the lines this event is worth sending; [] means "nothing to send". */
function classify(hook: HookInput, env: NodeJS.ProcessEnv, xf: Extractors): MirrorMessage[] {
  const token = env[ENV_MIRROR];
  const cc = hook.session_id;
  if (!token || !MIRROR_TOKEN.test(token) || !cc) return [];
  const msg = (line: MirrorMessage["line"]): MirrorMessage => ({ type: "mirror", token, cc_session: cc, line });
  switch (hook.hook_event_name) {
    case "UserPromptSubmit": {
      const text = hook.prompt;
      // clipped here too, in bytes: a pasted wall of text the daemon would reject must not be sent at all
      return text && text.trim() ? [msg({ kind: "user_prompt", text: clipBytes(text, MAX_TEXT_BYTES) })] : [];
    }
    case "PreToolUse": {
      const tool = hook.tool_name;
      if (!tool || INTERNAL_TOOLS.has(tool)) return [];
      return [msg({ kind: "tool_start", tool_name: tool, summary: toolStartSummary(tool, hook.tool_input) })];
    }
    case "PostToolUse": {
      const tool = hook.tool_name;
      if (!tool || INTERNAL_TOOLS.has(tool)) return [];
      if (tool === DESK_ON_TOOL) {
        const hist = xf.extractHistory(readTranscript(hook.transcript_path));
        return hist && hist.trim() ? [msg({ kind: "history", text: hist })] : [];
      }
      return [msg({ kind: "tool_end", tool_name: tool, ok: toolEndOk(hook.tool_response), summary: toolEndSummary(hook.tool_response) })];
    }
    case "Stop": {
      const text = xf.extractTurnAssistant(readTranscript(hook.transcript_path));
      return [ ...(text && text.trim() ? [msg({ kind: "assistant", text })] : []), msg({ kind: "turn_end" }) ];
    }
    default:
      return [];
  }
}

/** The pinned two-argument form: classify with the real (Task 6) extractors. */
export function mirrorLinesFor(hook: HookInput, env: NodeJS.ProcessEnv): MirrorMessage[] {
  return classify(hook, env, { extractTurnAssistant, extractHistory });
}

/** One hook run, start to finish. Always resolves 0; the optional `o` seams exist for tests
 * (Task 6 replaces the defaulted stubs with the real extractors, the seams stay). */
export async function runMirrorHook(
  stdinJson: string,
  env: NodeJS.ProcessEnv,
  socketPath: string,
  o?: { extractTurnAssistant?: (t: string) => string | undefined; extractHistory?: (t: string) => string | undefined },
): Promise<number> {
  let lines: MirrorMessage[] = [];
  try {
    const hook = JSON.parse(stdinJson) as HookInput;
    lines = classify(hook, env, {
      extractTurnAssistant: o?.extractTurnAssistant ?? extractTurnAssistant,
      extractHistory: o?.extractHistory ?? extractHistory,
    });
  } catch { return 0; }
  if (lines.length === 0) return 0;
  await sendLines(lines, socketPath);
  return 0;
}

/** Write every line in order on one connection and wait for it to leave. Never rejects: a
 * dead socket, an EPIPE, or a daemon that stopped reading all mean "send failed, say nothing". */
function sendLines(lines: MirrorMessage[], socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    let sock: Socket;
    try { sock = createConnection(socketPath); } catch { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve();
    };
    const timer = setTimeout(finish, MIRROR_TIMEOUT_MS);
    sock.on("error", finish);
    sock.on("close", finish);
    sock.on("connect", () => {
      try {
        for (const l of lines) sock.write(encode(l));
        sock.end(finish);
      } catch { finish(); }
    });
  });
}
