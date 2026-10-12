/** Where claude-telegram keeps its files: $CLAUDE_TELEGRAM_DATA_DIR, else
 * $XDG_DATA_HOME/claude-telegram, else ~/.local/share/claude-telegram. */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DeskPaths {
  dataDir: string;
  /** The daemon's socket; each session's channel server connects here. */
  socket: string;
  /** Desk sessions and the desk group id (SQLite). */
  db: string;
  /** The MCP config `claude-telegram code` hands to Claude Code. */
  mcpConfig: string;
}

export function deskPaths(env: NodeJS.ProcessEnv = process.env): DeskPaths {
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  const dataDir = env.CLAUDE_TELEGRAM_DATA_DIR || join(xdg, "claude-telegram");
  return { dataDir, socket: join(dataDir, "desk.sock"), db: join(dataDir, "desk.db"), mcpConfig: join(dataDir, "desk-mcp.json") };
}

/** Create the data folder owner-only, and take group/other access away if it has any. */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (st.uid === process.getuid?.() && st.mode & 0o077) chmodSync(dir, 0o700);
}
