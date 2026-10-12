/**
 * Deliver a phone message into a live Claude Code pane and relay the reply.
 *
 * One process owns each session: the interactive `claude` in its tmux pane.
 * The bot never resumes or spawns a second process on that session (that forks
 * it into two diverging histories). It types into the pane, exactly as if the
 * owner were at the keyboard, and reads the reply back from the transcript.
 *
 * Safety gates before any keystroke, re-checked fresh each time:
 *   - the pane still exists and its foreground command is `claude`;
 *   - the process status file says idle (or only a background shell);
 *   - the pane shows no spinner, no open prompt, and no unsent draft
 *     (typing would append to whatever the owner left in the box).
 * If a gate fails the message waits in a per-pane queue and is delivered in
 * order once the pane is free.
 */

import { stat } from "node:fs/promises";
import { probePane, type DiscoveryConfig } from "./discovery.js";
import { analyzePane, buildSendArgs, runTmux, type PanePrompt, type TmuxConfig } from "./tmux.js";
import { readFrom, readHeadTail, transcriptBusy, TurnTracker } from "./transcript.js";

export interface DeliverCallbacks {
  /** One assistant text block from the turn. */
  onText: (text: string) => Promise<void>;
  /** A permission/choice prompt opened in the pane mid-turn. */
  onPrompt: (prompt: PanePrompt, paneId: string) => Promise<void>;
  /** Status notices (queued, delivered, timed out…). */
  onNotice: (text: string) => Promise<void>;
}

export interface DeliverOptions {
  signal?: AbortSignal;
  pollMs?: number;
  /** How long a message may wait in the queue for a busy pane. */
  queueTimeoutMs?: number;
  /** How long to wait for the prompt to show up in the transcript. */
  landTimeoutMs?: number;
  /** Hard cap on one turn. */
  turnTimeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export async function capturePane(tmux: TmuxConfig, paneId: string): Promise<string> {
  return runTmux(tmux, ["capture-pane", "-p", "-e", "-t", paneId]);
}

export type Readiness =
  | { ok: true; transcript: string }
  | { ok: false; reason: string; fatal: boolean; prompt?: PanePrompt };

/** Fresh check of every gate. `fatal` = waiting won't help. */
export async function checkReady(cfg: DiscoveryConfig, paneId: string): Promise<Readiness> {
  const probe = await probePane(cfg, paneId);
  if (!probe) return { ok: false, reason: "that pane no longer runs a Claude session", fatal: true };
  if (probe.pane.command !== "claude") {
    return { ok: false, reason: `the pane is running \`${probe.pane.command}\`, not claude`, fatal: false };
  }
  const st = analyzePane(await capturePane(cfg.tmux, paneId));
  if (st.prompt || probe.session.status === "waiting") {
    return { ok: false, reason: "the session is waiting on a prompt", fatal: false, prompt: st.prompt ?? undefined };
  }
  if (probe.session.status === "busy" || st.busy) return { ok: false, reason: "the session is mid-turn", fatal: false };
  // Status file without a status (seen on a fresh session): ask the transcript.
  if (probe.session.status === "unknown") {
    const recs = await readHeadTail(probe.transcript, 0, 64 * 1024).catch(() => []);
    if (transcriptBusy(recs)) return { ok: false, reason: "the session is mid-turn", fatal: false };
  }
  if (st.draft) return { ok: false, reason: "its prompt box has unsent text", fatal: false };
  return { ok: true, transcript: probe.transcript };
}

// Per-pane FIFO: a message only starts once the previous one's turn is over.
const chains = new Map<string, Promise<void>>();
const queued = new Map<string, number>();

export function queueDepth(paneId: string): number {
  return queued.get(paneId) ?? 0;
}

export function deliver(
  cfg: DiscoveryConfig,
  paneId: string,
  text: string,
  cb: DeliverCallbacks,
  opts: DeliverOptions = {},
): Promise<void> {
  const prev = chains.get(paneId) ?? Promise.resolve();
  queued.set(paneId, queueDepth(paneId) + 1);
  const run = prev
    .catch(() => undefined)
    .then(() => deliverNow(cfg, paneId, text, cb, opts))
    .finally(() => {
      const d = queueDepth(paneId) - 1;
      if (d <= 0) queued.delete(paneId);
      else queued.set(paneId, d);
      if (chains.get(paneId) === run) chains.delete(paneId);
    });
  chains.set(paneId, run);
  return run;
}

async function deliverNow(
  cfg: DiscoveryConfig,
  paneId: string,
  text: string,
  cb: DeliverCallbacks,
  opts: DeliverOptions,
): Promise<void> {
  const poll = opts.pollMs ?? 1500;
  const signal = opts.signal;

  // 1. Wait for the pane to be free.
  const queueDeadline = Date.now() + (opts.queueTimeoutMs ?? 2 * 60 * 60_000);
  let notified = false;
  let forwardedHash: string | null = null;
  let ready: Readiness;
  for (;;) {
    if (signal?.aborted) return;
    ready = await checkReady(cfg, paneId);
    if (ready.ok) break;
    if (ready.fatal) {
      await cb.onNotice(`⚠️ Not sent: ${ready.reason}.`);
      return;
    }
    if (ready.prompt && ready.prompt.hash !== forwardedHash) {
      forwardedHash = ready.prompt.hash;
      await cb.onPrompt(ready.prompt, paneId);
    }
    if (!notified) {
      notified = true;
      await cb.onNotice(`⏳ Queued: ${ready.reason}. I'll send it when it's free.`);
    }
    if (Date.now() > queueDeadline) {
      await cb.onNotice(`⌛ Gave up waiting (${ready.reason}). Message not sent.`);
      return;
    }
    await sleep(poll * 2, signal);
  }

  // 2. Mark the transcript position, then type + submit.
  const transcript = ready.transcript;
  let offset = 0;
  try {
    offset = (await stat(transcript)).size;
  } catch {
    // first prompt of a fresh session creates the file
  }
  const args = buildSendArgs(paneId, text);
  await runTmux(cfg.tmux, args.type);
  await sleep(300);
  await runTmux(cfg.tmux, args.submit);
  if (notified) await cb.onNotice("📨 Sent.");

  // 3. Tail the transcript until the turn ends.
  const tracker = new TurnTracker();
  const started = Date.now();
  const landBy = started + (opts.landTimeoutMs ?? 30_000);
  const turnBy = started + (opts.turnTimeoutMs ?? 3 * 60 * 60_000);
  let lastGrowth = Date.now();
  let idleSince: number | null = null;

  while (!signal?.aborted) {
    const r = await readFrom(transcript, offset);
    if (r.offset !== offset) lastGrowth = Date.now();
    offset = r.offset;
    for (const t of tracker.feed(r.records)) await cb.onText(t);
    if (tracker.ended) return;

    if (!tracker.started && Date.now() > landBy) {
      await cb.onNotice(
        "⚠️ Typed it into the pane, but it never showed up as a prompt in the transcript. Check the terminal.",
      );
      return;
    }
    if (Date.now() > turnBy) {
      await cb.onNotice("⌛ Stopped watching this turn (3h cap). The session keeps running.");
      return;
    }

    const probe = await probePane(cfg, paneId);
    if (!probe) {
      await cb.onNotice("⚠️ The session's process went away mid-turn.");
      return;
    }
    if (probe.session.status === "waiting") {
      const st = analyzePane(await capturePane(cfg.tmux, paneId));
      if (st.prompt && st.prompt.hash !== forwardedHash) {
        forwardedHash = st.prompt.hash;
        await cb.onPrompt(st.prompt, paneId);
      }
    } else {
      forwardedHash = null;
    }

    // Fallback end: the process reports idle, the last reply was end_turn and
    // the file has been quiet a while (e.g. a build that skips turn_duration).
    if (tracker.started && probe.session.status === "idle") {
      idleSince ??= Date.now();
      if (tracker.sawEndTurn && Date.now() - idleSince > 8000 && Date.now() - lastGrowth > 8000) return;
    } else {
      idleSince = null;
    }
    await sleep(poll, signal);
  }
}

/** Answer a prompt by pressing the option's key — only if it's still that prompt. */
export async function answerPrompt(
  cfg: DiscoveryConfig,
  paneId: string,
  hash: string,
  key: string,
): Promise<string> {
  if (!/^\d$/.test(key)) return "invalid option";
  const probe = await probePane(cfg, paneId);
  if (!probe || probe.pane.command !== "claude") return "session is gone";
  const st = analyzePane(await capturePane(cfg.tmux, paneId));
  if (!st.prompt || st.prompt.hash !== hash) return "that prompt is no longer open";
  if (!st.prompt.options.some((o) => o.key === key)) return "option not on the prompt";
  await runTmux(cfg.tmux, ["send-keys", "-t", paneId, key]);
  return "ok";
}

/** Esc into the pane — Claude Code's interrupt. Only when it's actually busy. */
export async function interruptPane(cfg: DiscoveryConfig, paneId: string): Promise<boolean> {
  const probe = await probePane(cfg, paneId);
  if (!probe || probe.pane.command !== "claude") return false;
  if (probe.session.status !== "busy" && probe.session.status !== "waiting") return false;
  await runTmux(cfg.tmux, ["send-keys", "-t", paneId, "Escape"]);
  return true;
}
