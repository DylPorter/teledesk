/**
 * Discovery: which tmux panes are running which live Claude Code sessions.
 *
 * Chain: tmux pane → pane_pid → descendant `claude` process → the process's
 * status file `<claude-dir>/sessions/<pid>.json` → the transcript at
 * `<claude-dir>/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * The status file is undocumented. Fields relied on (2.1.28x):
 *   pid, sessionId, cwd, kind ("interactive" for a terminal session),
 *   status ("idle" | "busy" | "shell" | "waiting"), name, updatedAt.
 * `status` is how Claude Code itself decides "working" vs "blocked" in its
 * session list: "waiting" means a permission/choice prompt is open; "shell"
 * means only a background shell is running and the prompt box is free.
 * The file also has a `tmux` field ("session:@win.%pane") but it doesn't
 * name the tmux socket, so the process tree is the authoritative link.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runTmux, type TmuxConfig } from "./tmux.js";
import { readHeadTail, summarize, type TranscriptSummary } from "./transcript.js";

export type ProcStatus = "idle" | "busy" | "shell" | "waiting" | "unknown";

export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string;
  status: ProcStatus;
  name: string | null;
  updatedAt: number | null;
}

export interface Pane {
  paneId: string; // "%12"
  panePid: number;
  command: string; // pane_current_command
  target: string; // "session:window.pane"
}

export interface Proc {
  pid: number;
  ppid: number;
  comm: string;
}

export interface LiveSession {
  n: number;
  paneId: string;
  paneTarget: string;
  pid: number;
  sessionId: string;
  cwd: string;
  project: string;
  status: ProcStatus;
  transcript: string;
  title: string | null;
  summary: TranscriptSummary;
  lastActivity: number | null;
  /** Foreground command is claude, i.e. it's safe to type into. */
  foregroundClaude: boolean;
}

const STATUSES = new Set(["idle", "busy", "shell", "waiting"]);

export function parseSessionFile(json: string): SessionFile | null {
  let d: any;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  if (!d || typeof d.pid !== "number" || typeof d.sessionId !== "string" || typeof d.cwd !== "string") {
    return null;
  }
  return {
    pid: d.pid,
    sessionId: d.sessionId,
    cwd: d.cwd,
    kind: typeof d.kind === "string" ? d.kind : "interactive",
    status: STATUSES.has(d.status) ? d.status : "unknown",
    name: typeof d.name === "string" ? d.name : null,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : null,
  };
}

/** Claude Code's project-dir naming: every non-alphanumeric char → "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export const PANE_FORMAT =
  "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}";

export function parsePanes(out: string): Pane[] {
  const panes: Pane[] = [];
  for (const line of out.split("\n")) {
    const [paneId, pid, command, target] = line.split("\t");
    if (!paneId || !pid) continue;
    panes.push({ paneId, panePid: Number(pid), command: command ?? "", target: target ?? paneId });
  }
  return panes;
}

/** `ps -e -o pid=,ppid=,comm=` output. */
export function parseProcTable(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] });
  }
  return procs;
}

/**
 * The claude process for a pane: the pane process itself or a descendant
 * (typically shell → claude), preferring one that has a status file.
 */
export function findClaudePid(
  panePid: number,
  procs: Proc[],
  hasSession: (pid: number) => boolean,
): number | null {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const comm = new Map(procs.map((p) => [p.pid, p.comm]));
  let frontier = [panePid];
  let fallback: number | null = null;
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (comm.get(pid) === "claude") {
        if (hasSession(pid)) return pid;
        fallback ??= pid;
      }
      next.push(...(children.get(pid) ?? []));
    }
    frontier = next;
  }
  return fallback !== null && hasSession(fallback) ? fallback : null;
}

export interface MatchedPane {
  pane: Pane;
  session: SessionFile;
}

/** Pure join of panes × process tree × status files. Sorted by pane target. */
export function matchPanes(
  panes: Pane[],
  procs: Proc[],
  sessions: Map<number, SessionFile>,
): MatchedPane[] {
  const out: MatchedPane[] = [];
  for (const pane of panes) {
    const pid = findClaudePid(pane.panePid, procs, (p) => sessions.has(p));
    if (pid === null) continue;
    const session = sessions.get(pid)!;
    if (session.kind !== "interactive") continue;
    out.push({ pane, session });
  }
  return out.sort((a, b) =>
    a.pane.target.localeCompare(b.pane.target, undefined, { numeric: true }),
  );
}

// ── I/O ────────────────────────────────────────────────────────────────────

export interface DiscoveryConfig {
  tmux: TmuxConfig;
  /** Claude Code's config dir (normally ~/.claude). */
  claudeDir: string;
}

function ps(): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("ps", ["-e", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
}

export async function readSessionFiles(claudeDir: string): Promise<Map<number, SessionFile>> {
  const dir = path.join(claudeDir, "sessions");
  const map = new Map<number, SessionFile>();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return map;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const s = parseSessionFile(await readFile(path.join(dir, n), "utf8"));
          if (s) map.set(s.pid, s);
        } catch {
          // raced with the process exiting
        }
      }),
  );
  return map;
}

export async function transcriptPath(claudeDir: string, s: SessionFile): Promise<string> {
  const direct = path.join(claudeDir, "projects", encodeProjectDir(s.cwd), `${s.sessionId}.jsonl`);
  try {
    await stat(direct);
    return direct;
  } catch {
    // fall back to a scan — the encoding rule is inferred, not documented
  }
  try {
    for (const d of await readdir(path.join(claudeDir, "projects"))) {
      const p = path.join(claudeDir, "projects", d, `${s.sessionId}.jsonl`);
      try {
        await stat(p);
        return p;
      } catch {
        /* next */
      }
    }
  } catch {
    /* no projects dir */
  }
  return direct; // may not exist yet: a fresh session writes it on first prompt
}

/** Status of one pane's claude process, re-read fresh. Null if gone. */
export async function probePane(
  cfg: DiscoveryConfig,
  paneId: string,
): Promise<{ pane: Pane; session: SessionFile; transcript: string } | null> {
  const [paneOut, procOut, sessions] = await Promise.all([
    runTmux(cfg.tmux, ["list-panes", "-a", "-F", PANE_FORMAT]).catch(() => ""),
    ps(),
    readSessionFiles(cfg.claudeDir),
  ]);
  const match = matchPanes(
    parsePanes(paneOut).filter((p) => p.paneId === paneId),
    parseProcTable(procOut),
    sessions,
  )[0];
  if (!match) return null;
  return { ...match, transcript: await transcriptPath(cfg.claudeDir, match.session) };
}

export async function listLiveSessions(cfg: DiscoveryConfig): Promise<LiveSession[]> {
  let paneOut: string;
  try {
    paneOut = await runTmux(cfg.tmux, ["list-panes", "-a", "-F", PANE_FORMAT]);
  } catch {
    return []; // no tmux server
  }
  const [procOut, sessions] = await Promise.all([ps(), readSessionFiles(cfg.claudeDir)]);
  const matched = matchPanes(parsePanes(paneOut), parseProcTable(procOut), sessions);

  return Promise.all(
    matched.map(async ({ pane, session }, i): Promise<LiveSession> => {
      const transcript = await transcriptPath(cfg.claudeDir, session);
      let summary: TranscriptSummary = { title: null, firstPrompt: null, recentPrompts: [] };
      let lastActivity = session.updatedAt;
      try {
        summary = summarize(await readHeadTail(transcript));
        lastActivity = Math.max(lastActivity ?? 0, (await stat(transcript)).mtimeMs);
      } catch {
        // no transcript yet
      }
      return {
        n: i + 1,
        paneId: pane.paneId,
        paneTarget: pane.target,
        pid: session.pid,
        sessionId: session.sessionId,
        cwd: session.cwd,
        project: path.basename(session.cwd) || session.cwd,
        status: session.status,
        transcript,
        title: summary.title ?? session.name,
        summary,
        lastActivity,
        foregroundClaude: pane.command === "claude",
      };
    }),
  );
}

export function sessionLabel(s: Pick<LiveSession, "project" | "title">): string {
  return s.title ? `${s.project} · ${s.title}` : s.project;
}
