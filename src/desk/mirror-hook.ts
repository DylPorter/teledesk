/** `teledesk mirror-hook` — the entrypoint Claude Code's hooks run: hook JSON in on stdin,
 * protocol mirror lines out to the daemon's desk socket, exit 0 whatever happens. The hook
 * must never disturb the session it observes, so every failure path (bad JSON, unknown event,
 * dead daemon, EPIPE, timeout) is silent and returns 0; nothing is ever written to stdout or
 * stderr — the session token in the env is a secret, and hook noise lands in the transcript.
 * Shell-level backgrounding of tool-event hooks is the installer's job (spike (c) + Task 9);
 * this CLI does one synchronous pass and stays dependency-light (protocol only). */
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { clip, encode, MIRROR_TOKEN, oneLine, type MirrorMessage } from "./protocol.js";

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

/** Task 6 replaces this stub (last assistant text of the turn from the transcript JSONL). */
export function extractTurnAssistant(_transcript: string): string | undefined { return undefined; }

/** Task 6 replaces this stub (a capped snapshot of the earlier conversation). */
export function extractHistory(_transcript: string, _maxTurns?: number, _perTurnChars?: number): string | undefined { return undefined; }

/** Task 6 replaces these placeholders with per-tool summaries (incl. Agent/Task dispatch lines);
 * toolName is unused until then but stays in the signature — Task 6 pins it. */
export function toolStartSummary(_toolName: string, input: unknown): string { return summarize(input, 200); }
export function toolEndSummary(response: unknown): string { return summarize(response, 300); }
const summarize = (x: unknown, n: number): string => (x === undefined ? "" : oneLine(clip(JSON.stringify(x) ?? "", n)));

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
      return text && text.trim() ? [msg({ kind: "user_prompt", text })] : [];
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
