/**
 * tmux plumbing for the live-session bridge.
 *
 * Everything that touches a pane goes through here. The pure pieces (argument
 * construction, pane-text analysis) are exported separately so they can be
 * tested without a tmux server; `runTmux` is the only thing that executes.
 *
 * Observed against Claude Code 2.1.28x in tmux 3.x:
 *  - `send-keys -l` types text literally. A LF inside it inserts a newline in
 *    the prompt box (Claude reads LF as "newline", CR as "submit"), so
 *    multi-line messages need no special paste handling. The trailing `Enter`
 *    key (CR) is what submits.
 *  - A turn in progress shows a spinner line like `· Moseying… (3s · thinking)`.
 *    Older builds also printed "esc to interrupt"; both are treated as busy.
 *  - A permission prompt renders below the last horizontal rule as a question
 *    plus numbered options, the selected one marked `❯`. Typing the digit picks
 *    that option directly — no Enter needed.
 */

import { execFile } from "node:child_process";

export interface TmuxConfig {
  /** tmux binary. */
  bin: string;
  /** Optional `-L <socket-name>`; unset = the default server. */
  socket?: string;
}

export function baseArgs(cfg: TmuxConfig): string[] {
  return cfg.socket ? ["-L", cfg.socket] : [];
}

export function runTmux(cfg: TmuxConfig, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cfg.bin,
      [...baseArgs(cfg), ...args],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Normalise a phone message before it is typed into a terminal.
 *
 * CRLF/CR become LF (a bare CR would submit mid-message). Tabs become spaces
 * (Tab drives autocomplete in the prompt box). Every other C0/C1 control
 * character, ESC included, is dropped, so a message can never smuggle a key
 * sequence or terminal escape into the pane.
 */
export function normalizeOutgoing(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+$/u, "");
}

/**
 * The tmux invocations that type `text` into `target` and submit it.
 *
 * (`runTmux` prepends the socket flag.) Two separate commands on purpose: the literal text first (with `--` so a
 * message beginning with "-" is never read as a flag), then a real Enter key.
 * The caller pauses briefly between them so the TUI has consumed the text.
 */
export function buildSendArgs(
  target: string,
  text: string,
): { type: string[]; submit: string[] } {
  const clean = normalizeOutgoing(text);
  if (!clean) throw new Error("refusing to send an empty message");
  return {
    type: ["send-keys", "-t", target, "-l", "--", clean],
    submit: ["send-keys", "-t", target, "Enter"],
  };
}

// ── pane analysis ─────────────────────────────────────────────────────────

export interface PanePrompt {
  /** Question text shown above the options. */
  question: string;
  options: { key: string; label: string }[];
  /** Short stable hash of the prompt, used to match a button to its prompt. */
  hash: string;
}

export interface PaneState {
  busy: boolean;
  prompt: PanePrompt | null;
  /** Unsent text sitting in the prompt box, or null if it's empty. */
  draft: string | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

const RULE = /^\s*─{20,}\s*$/;
const SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^(]*…\s*\((?:\d|esc|thinking)/iu;
const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(.*\S)\s*$/u;

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

/**
 * Parse a `capture-pane -p -e` dump (ANSI kept so placeholder text, which is
 * rendered dim, can be told apart from a real draft). Plain captures work too;
 * they just can't distinguish a placeholder from a draft.
 */
export function analyzePane(raw: string): PaneState {
  const rawLines = raw.split("\n");
  const lines = rawLines.map(stripAnsi);

  const busy = lines.some((l) => SPINNER.test(l) || /esc to interrupt/i.test(l));

  // Everything after the last horizontal rule: the footer when idle, the
  // whole prompt dialog when one is open.
  let lastRule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      lastRule = i;
      break;
    }
  }
  const tail = lines.slice(lastRule + 1);
  let prompt: PanePrompt | null = null;
  const optIdx = tail.findIndex((l) => OPTION.test(l));
  const hasCursor = tail.some((l) => /^\s*❯\s*\d\./u.test(l));
  if (optIdx >= 0 && hasCursor) {
    const question = tail
      .slice(0, optIdx)
      .map((l) => l.trim())
      .filter((l) => l && !/^Tip:/i.test(l))
      .join("\n");
    const options: { key: string; label: string }[] = [];
    for (const l of tail.slice(optIdx)) {
      const m = OPTION.exec(l);
      if (m) {
        options.push({ key: m[1], label: m[2] });
      } else if (/^\s*(Esc to|Enter to)/i.test(l) || !l.trim()) {
        continue;
      } else if (options.length && /^\s{4,}\S/.test(l)) {
        options[options.length - 1].label += " " + l.trim();
      }
    }
    if (options.length >= 2) {
      prompt = {
        question,
        options,
        hash: shortHash(question + "|" + options.map((o) => o.label).join("|")),
      };
    }
  }

  // Prompt box: a "❯" line directly under a rule. Text rendered dim right
  // after the marker is the placeholder ("Try …"), not a draft.
  let draft: string | null = null;
  if (!prompt) {
    for (let i = lines.length - 1; i > 0; i--) {
      if (!/^❯/u.test(lines[i]) || !RULE.test(lines[i - 1])) continue;
      const first = rawLines[i]
        .replace(/\u001b\[2m[\s\S]*?(\u001b\[(?:0|22)?m|$)/g, "")
        .replace(ANSI, "")
        .replace(/^❯\s?/u, "");
      const parts = [first];
      for (let j = i + 1; j < lines.length && !RULE.test(lines[j]); j++) {
        parts.push(lines[j]);
      }
      const text = parts.join("\n").trim();
      draft = text ? text : null;
      break;
    }
  }

  return { busy, prompt, draft };
}
