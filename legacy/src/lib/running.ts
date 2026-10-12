/**
 * Registry of in-flight Claude runs, keyed by chat.
 *
 * The bot spawns one `claude -p` child per turn. Without tracking, there's no
 * way to interrupt a runaway except killing the whole systemd service. This
 * holds an abort handle + PID per chat so a /stop command — or a new message —
 * can cull the current run's whole process group.
 *
 * Single job per chat: with interrupt-on-new-message, a fresh turn always
 * supersedes the previous one, so we never need more than one live job per chat.
 */
export interface RunningJob {
  chatId: number;
  pid: number;
  startedAt: number;
  /** Trigger the kill (aborts the AbortController wired into streamClaude). */
  abort: () => void;
  /** Short label (truncated prompt) for status/logging. */
  label: string;
}

const running = new Map<number, RunningJob>();

export function register(job: RunningJob): void {
  running.set(job.chatId, job);
}

/**
 * Remove a job, but only if it's still the one we registered. The PID guard
 * stops a finishing old turn from evicting the new turn that just replaced it.
 */
export function deregister(chatId: number, pid: number): void {
  const cur = running.get(chatId);
  if (cur && cur.pid === pid) running.delete(chatId);
}

export function getRunning(chatId: number): RunningJob | undefined {
  return running.get(chatId);
}

/** Abort and remove the current job for a chat. Returns it, or null if none. */
export function stopChat(chatId: number): RunningJob | null {
  const job = running.get(chatId);
  if (!job) return null;
  job.abort();
  running.delete(chatId);
  return job;
}
