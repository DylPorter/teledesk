/**
 * Sticky routing: messages go to the session you're already talking to.
 *
 * The router only moves a message elsewhere when it is confident the message
 * belongs to a different session. Short follow-ups skip the router entirely
 * (no 5–9 s classify call). After a long silence the stickiness lapses and
 * routing falls back to the plain classifier.
 */

import type { Pin } from "../session.js";
import { sessionLabel, type LiveSession } from "./discovery.js";
import type { RouteDecision } from "./router.js";

export type Target = Pin;

export const SWITCH_CONFIDENCE = 0.85;
export const SHORT_FOLLOWUP_CHARS = 40;
export const STICKY_MS = 6 * 60 * 60_000;

export type Plan =
  | { go: "stay"; target: Target }
  | { go: "classify"; current: Target }
  | { go: "route" };

/** Is `t` still somewhere a message can go? The bot session always is. */
export function isAlive(t: Target, sessions: LiveSession[]): boolean {
  return t.kind === "bot" || sessions.some((s) => s.paneId === t.paneId);
}

export function planRoute(
  current: Target | null | undefined,
  lastAt: number | null | undefined,
  text: string,
  sessions: LiveSession[],
  now = Date.now(),
): Plan {
  if (!current || !lastAt || now - lastAt > STICKY_MS || !isAlive(current, sessions)) {
    return { go: "route" };
  }
  if (text.trim().length < SHORT_FOLLOWUP_CHARS) return { go: "stay", target: current };
  return { go: "classify", current };
}

/** After classifying: stay unless the router is confident about somewhere else. */
export function resolveSticky(
  current: Target,
  decision: RouteDecision | null,
  sessions: LiveSession[],
): { go: "stay" } | { go: "switch"; to: Target; label: string } {
  if (!decision || decision.confidence < SWITCH_CONFIDENCE) return { go: "stay" };
  if (decision.target === "new") {
    return current.kind === "bot" ? { go: "stay" } : { go: "switch", to: { kind: "bot" }, label: "bot session" };
  }
  const s = sessions[decision.target - 1];
  if (!s || (current.kind === "pane" && current.paneId === s.paneId)) return { go: "stay" };
  const label = sessionLabel(s);
  return { go: "switch", to: { kind: "pane", paneId: s.paneId, label }, label };
}
