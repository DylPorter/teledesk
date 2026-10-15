/** `teledesk install`: make plain `claude` desk-capable in interactive shells, and add
 * the /desk command to Claude Code. Sessions then start with the desk channel loaded but
 * DORMANT — no topic, nothing on Telegram — until /desk turns the desk on for that session.
 * Idempotent; `teledesk uninstall` removes exactly what install added. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installShim, uninstallShim } from "./shim.js";

export const BLOCK_START = "# >>> teledesk >>>";
export const BLOCK_END = "# <<< teledesk <<<";

/** The shell wrapper: inside a desk session (the guard the launcher sets) plain claude, so
 * nothing recurses; everywhere else claude with the desk channel loaded. `teledesk
 * code` passes non-interactive runs (-p, subcommands, --version…) straight to plain claude. */
export function shellBlock(): string {
  return [
    BLOCK_START,
    "# Plain `claude` starts desk-capable; /desk inside a session opens its Telegram topic.",
    "claude() {",
    '  if [ -n "$TELEDESK" ]; then command claude "$@"; else command teledesk code "$@"; fi',
    "}",
    BLOCK_END,
  ].join("\n");
}

/** The rc text with the block installed (replaced if an older copy is there). */
export function installBlock(rc: string): string {
  const start = rc.indexOf(BLOCK_START);
  if (start >= 0) {
    const end = rc.indexOf(BLOCK_END, start);
    if (end >= 0) return rc.slice(0, start) + shellBlock() + rc.slice(end + BLOCK_END.length);
  }
  return (rc === "" || rc.endsWith("\n") ? rc : rc + "\n") + "\n" + shellBlock() + "\n";
}

/** The rc text with the block removed. */
export function uninstallBlock(rc: string): string {
  const start = rc.indexOf(BLOCK_START);
  if (start < 0) return rc;
  const end = rc.indexOf(BLOCK_END, start);
  if (end < 0) return rc;
  return (rc.slice(0, start) + rc.slice(end + BLOCK_END.length)).replace(/\n{3,}/g, "\n\n");
}

/** The /desk slash command (user scope, so it exists in every project). */
export const DESK_COMMAND = `---
description: Open this session's Telegram topic ("/desk off" hides it until the next /desk)
allowed-tools: mcp__teledesk__desk_on, mcp__teledesk__desk_off
---
If the user's argument is "off", call the mcp__teledesk__desk_off tool. Otherwise call the mcp__teledesk__desk_on tool. Then tell the user in one short line what happened (the topic name, or why it couldn't open). Do nothing else.
`;

export interface InstallReport { changed: string[]; skipped: string[] }

const RC_FILES = [".bashrc", ".zshrc"];

const merge = (a: InstallReport, b: InstallReport): InstallReport =>
  ({ changed: [...a.changed, ...b.changed], skipped: [...a.skipped, ...b.skipped] });

/** Install into a home folder (the real one by default). Only rc files that already exist are
 * touched; the command file is (re)written either way. `shim: true` (`teledesk install --shim`)
 * also puts a desk-aware `claude` in ~/bin, which is what reaches shells that never read the rc
 * file — old tmux panes, `sh -c`, systemd units. Off by default: that is a machine-wide
 * intercept of the binary's name, not a shell setting. */
export function install(home = homedir(), opts: { shim?: boolean } = {}): InstallReport {
  const report: InstallReport = { changed: [], skipped: [] };
  for (const name of RC_FILES) {
    const rc = join(home, name);
    if (!existsSync(rc)) { report.skipped.push(rc); continue; }
    const before = readFileSync(rc, "utf8");
    const after = installBlock(before);
    if (after !== before) { writeFileSync(rc, after); report.changed.push(rc); }
    else report.skipped.push(rc);
  }
  const cmd = join(home, ".claude", "commands", "desk.md");
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(cmd, DESK_COMMAND);
  report.changed.push(cmd);
  return opts.shim ? merge(report, installShim(home)) : report;
}

/** Remove what install added, shim included (a `~/bin/claude` that isn't ours is left alone). */
export function uninstall(home = homedir()): InstallReport {
  const report: InstallReport = { changed: [], skipped: [] };
  for (const name of RC_FILES) {
    const rc = join(home, name);
    if (!existsSync(rc)) { report.skipped.push(rc); continue; }
    const before = readFileSync(rc, "utf8");
    const after = uninstallBlock(before);
    if (after !== before) { writeFileSync(rc, after); report.changed.push(rc); }
    else report.skipped.push(rc);
  }
  const cmd = join(home, ".claude", "commands", "desk.md");
  if (existsSync(cmd)) { rmSync(cmd); report.changed.push(cmd); }
  return merge(report, uninstallShim(home));
}
