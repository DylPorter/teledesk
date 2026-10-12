/**
 * Topic router: which live session does an unpinned phone message belong to?
 *
 * One cheap, tool-less `claude -p` call (haiku by default). It can't use tools,
 * has no MCP servers and persists no session, so it can't act on anything and
 * leaves no transcript behind — it only reads summaries and returns JSON.
 *
 * It does NOT go through `streamClaude`: that helper always runs with
 * bypassPermissions and full tools, which is the wrong shape for a classifier.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { LiveSession } from "./discovery.js";

export type RouteTarget = number | "new";

export interface RouteDecision {
  target: RouteTarget;
  confidence: number;
}

export function buildRouterPrompt(
  sessions: LiveSession[],
  message: string,
  previousTarget?: number,
): string {
  const lines = sessions.map((s) => {
    const bits = [`${s.n}. [${s.project}]${s.title ? ` "${s.title}"` : ""}`];
    if (s.summary.firstPrompt) bits.push(`   started with: ${s.summary.firstPrompt}`);
    for (const p of s.summary.recentPrompts) bits.push(`   recently: ${p}`);
    return bits.join("\n");
  });
  return [
    "You route a message the user sent from their phone to one of their open Claude Code sessions.",
    "Each session is a separate ongoing conversation in a project directory.",
    "",
    "Sessions:",
    ...lines,
    "",
    ...(previousTarget
      ? [`The user's previous phone message went to session ${previousTarget}. Short follow-ups ("yes", "do it") usually continue there.`, ""]
      : []),
    "Message:",
    '"""',
    message.slice(0, 2000),
    '"""',
    "",
    'Pick the session this message continues. If it starts a topic none of them covers, use "new".',
    "Reply with ONLY a JSON object, no prose, no code fence:",
    '{"target": <session number or "new">, "confidence": <number from 0 to 1>}',
  ].join("\n");
}

/**
 * Pull a RouteDecision out of whatever the model printed. Tolerates the
 * `--output-format json` envelope, code fences and surrounding prose; returns
 * null for anything that doesn't name a valid target.
 */
export function parseRouterOutput(raw: string, sessionCount: number): RouteDecision | null {
  let text = raw.trim();
  // Unwrap the CLI's JSON envelope ({"type":"result","result":"..."}).
  try {
    const env = JSON.parse(text);
    if (env && typeof env === "object" && typeof env.result === "string") text = env.result;
    else if (env && typeof env === "object" && "target" in env) return validate(env, sessionCount);
  } catch {
    // not an envelope; parse as free text
  }
  const candidates = text.match(/\{[^{}]*\}/g) ?? [];
  for (const c of candidates) {
    try {
      const d = validate(JSON.parse(c), sessionCount);
      if (d) return d;
    } catch {
      // try the next brace group
    }
  }
  return null;
}

function validate(obj: any, n: number): RouteDecision | null {
  if (!obj || typeof obj !== "object") return null;
  let target: RouteTarget;
  const t = obj.target;
  if (t === "new" || t === null || t === 0 || t === "0") target = "new";
  else {
    const num = typeof t === "number" ? t : typeof t === "string" && /^\d+$/.test(t.trim()) ? Number(t) : NaN;
    if (!Number.isInteger(num) || num < 1 || num > n) return null;
    target = num;
  }
  let conf = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.min(1, Math.max(0, conf));
  return { target, confidence: conf };
}

export interface RouterRunConfig {
  claudeBin: string;
  model: string;
  timeoutMs?: number;
}

export function routerArgs(prompt: string, model: string): string[] {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--effort",
    "low",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

export function classify(
  cfg: RouterRunConfig,
  sessions: LiveSession[],
  message: string,
  previousTarget?: number,
): Promise<RouteDecision | null> {
  const prompt = buildRouterPrompt(sessions, message, previousTarget);
  return new Promise((resolve) => {
    execFile(
      cfg.claudeBin,
      routerArgs(prompt, cfg.model),
      { cwd: tmpdir(), timeout: cfg.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn("[router] classify failed:", err.message.slice(0, 200));
          resolve(null);
          return;
        }
        resolve(parseRouterOutput(stdout, sessions.length));
      },
    );
  });
}
