import { spawn } from "node:child_process";
import { env } from "./env.js";

export type StreamEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; preview: string }
  | { kind: "system"; message: string }
  | { kind: "done"; sessionId: string | null; text: string; isError: boolean }
  | { kind: "error"; error: string };

export interface StreamOptions {
  message: string;
  cwd: string;
  resumeSessionId?: string | null;
  /** Override the default model for this single turn (e.g. "opus", "haiku"). */
  model?: string;
  /** Override the default effort for this single turn. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Abort signal — when aborted, the child's whole process group is killed. */
  signal?: AbortSignal;
  /** Invoked with the child PID once spawned (for the run registry). */
  onSpawn?: (pid: number) => void;
}

/**
 * Stream a Claude Code query using `--output-format stream-json`.
 * Yields one event per content block (in order) plus tool_result + done events.
 * Uses the user's Max plan authentication (no API key).
 */
export async function* streamClaude(
  opts: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const args = [
    "-p",
    opts.message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    opts.model ?? env.CLAUDE_MODEL,
    "--effort",
    opts.effort ?? env.CLAUDE_EFFORT,
  ];

  if (opts.resumeSessionId) {
    args.splice(2, 0, "--resume", opts.resumeSessionId);
  }

  // `detached: true` makes the child its own process-group leader, so an
  // interrupt can signal the whole tree (claude -> Bash tool -> curl, …) at
  // once via the negative PID. A plain proc.kill() orphans those grandchildren
  // — which is how a runaway kept mutating n8n after the parent looked idle.
  const proc = spawn(env.CLAUDE_BIN, args, {
    cwd: opts.cwd,
    env: { ...process.env },
    detached: true,
  });

  const events: (StreamEvent | null)[] = [];
  let resolveNext: (() => void) | null = null;

  const pushEvent = (ev: StreamEvent | null) => {
    events.push(ev);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  if (proc.pid !== undefined) opts.onSpawn?.(proc.pid);

  // External interrupt: SIGTERM the process group, then SIGKILL stragglers.
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already gone
    }
    killTimer = setTimeout(() => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, 4000);
    pushEvent(null); // end the stream now — don't wait for the child to die
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        for (const ev of mapEvent(obj)) pushEvent(ev);
      } catch {
        // ignore parse errors on partial lines
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) pushEvent({ kind: "system", message: text });
  });

  proc.on("close", (code) => {
    if (killTimer) clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    // A non-zero exit from an intentional interrupt isn't an error to report.
    if (code !== 0 && !opts.signal?.aborted) {
      pushEvent({ kind: "error", error: `claude exited ${code}` });
    }
    pushEvent(null); // sentinel
  });

  proc.on("error", (err) => {
    pushEvent({ kind: "error", error: `spawn: ${err.message}` });
    pushEvent(null);
  });

  while (true) {
    if (events.length === 0) {
      await new Promise<void>((r) => (resolveNext = r));
    }
    const ev = events.shift();
    if (ev === undefined) continue;
    if (ev === null) break;
    yield ev;
  }
}

/**
 * Convert a raw stream-json line into zero or more StreamEvents, preserving
 * content-block ordering within a single assistant message (so text that
 * follows a tool_use in the same message isn't dropped).
 */
function mapEvent(obj: any): StreamEvent[] {
  if (!obj || typeof obj !== "object") return [];

  if (obj.type === "result") {
    return [
      {
        kind: "done",
        sessionId: obj.session_id ?? null,
        text: obj.result ?? "",
        isError: obj.is_error === true,
      },
    ];
  }

  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    const out: StreamEvent[] = [];
    for (const block of obj.message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim()) out.push({ kind: "assistant_text", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({ kind: "tool_use", name: block.name, input: block.input });
      }
      // thinking blocks are intentionally dropped — Telegram doesn't need them
    }
    return out;
  }

  if (obj.type === "user" && Array.isArray(obj.message?.content)) {
    const out: StreamEvent[] = [];
    for (const block of obj.message.content) {
      if (block.type === "tool_result") {
        const preview =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
                  .join("")
              : JSON.stringify(block.content ?? "");
        out.push({
          kind: "tool_result",
          name: "result",
          preview: String(preview).slice(0, 300),
        });
      }
    }
    return out;
  }

  return [];
}
