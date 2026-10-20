/** `teledesk install`: make plain `claude` desk-capable in interactive shells, add the /desk
 * command to Claude Code, and register the four mirror hooks in ~/.claude/settings.json so a
 * desk session's chat and tool calls reach its Telegram topic. Sessions then start with the desk
 * channel loaded but DORMANT — no topic, nothing on Telegram — until /desk turns the desk on for
 * that session. Idempotent; `teledesk uninstall` removes exactly what install added. */
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

// ---- the four mirror hooks (spike 2026-10-18, section (c)) ----

/** The string that marks a settings.json hook command as ours: install replaces it in place and
 * uninstall strips exactly it, never touching a foreign hook that happens to share an event. */
export const HOOK_MARKER = "teledesk mirror-hook";

/** Every hook command opens with this guard: outside a desk session (no per-spawn mirror token in
 * the env) the hook exits 0 immediately and sends nothing, so a stray `teledesk` never posts. */
const HOOK_GUARD = '[ -n "$TELEDESK_MIRROR" ] || exit 0; ';
const FOREGROUND = HOOK_GUARD + HOOK_MARKER;
// Backgrounded form: the CLI reads the hook JSON off /dev/stdin and completes after the hook
// returns (spike (c)); stdout/stderr are redirected so nothing lands in the transcript.
const BACKGROUNDED = HOOK_GUARD + HOOK_MARKER + " </dev/stdin >/dev/null 2>&1 & exit 0";

const command = (c: string) => ({ type: "command", command: c });
const group = (c: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [command(c)] });

/** The settings `hooks` object for the four events. Chat events (UserPromptSubmit, Stop) run in
 * the foreground — Telegram ordering depends on it. Tool events (PreToolUse, PostToolUse) are
 * backgrounded when `backgroundTools` (the spike's default, and the real install path): CC blocks
 * a tool on its PreToolUse hook (spike (f)), so only a detached hook keeps session latency zero. */
export function hookEntries(backgroundTools: boolean): Record<string, unknown> {
  const tool = backgroundTools ? BACKGROUNDED : FOREGROUND;
  return {
    UserPromptSubmit: [group(FOREGROUND)],
    Stop: [group(FOREGROUND)],
    PreToolUse: [group(tool, "*")],
    PostToolUse: [group(tool, "*")],
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ourCommand = (h: unknown): boolean => isPlainObject(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER);

/** A group holding one of our marked hooks. */
const groupIsOurs = (g: unknown): boolean => isPlainObject(g) && Array.isArray(g.hooks) && (g.hooks as unknown[]).some(ourCommand);

/** Drop our marked hooks from a list of matcher groups, pruning any group emptied by that. A
 * group with no marked hook is returned by reference — foreign content stays byte-for-byte. */
function stripOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    if (!groupIsOurs(g)) { out.push(g); continue; }
    const kept = (g as Record<string, unknown>).hooks as unknown[];
    const foreign = kept.filter((h) => !ourCommand(h));
    if (foreign.length > 0) out.push({ ...(g as Record<string, unknown>), hooks: foreign });
  }
  return out;
}

/** Whether any group in an event's list holds one of our hooks. */
const groupListHasOurs = (groups: unknown): boolean => Array.isArray(groups) && (groups as unknown[]).some(groupIsOurs);

/** Deep-merge our entries into an existing settings object: our hooks replaced in place (never
 * duplicated), every foreign hook and every other settings key preserved untouched. Idempotent. */
export function mergeHookSettings(settings: unknown, entries: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = isPlainObject(settings) ? { ...settings } : {};
  const source = isPlainObject(base.hooks) ? (base.hooks as Record<string, unknown>) : {};
  const hooks: Record<string, unknown> = { ...source };
  for (const [event, ourGroups] of Object.entries(entries)) {
    const ours = Array.isArray(ourGroups) ? ourGroups : [];
    const cleaned = stripOurs(source[event]);
    hooks[event] = [...cleaned, ...ours];
  }
  base.hooks = hooks;
  return base;
}

/** Strip only our marked hooks from a settings object, pruning emptied groups, events, and the
 * hooks object itself. Foreign hooks and other settings keys are left untouched. */
export function removeHookSettings(settings: unknown): unknown {
  if (!isPlainObject(settings)) return settings;
  const base: Record<string, unknown> = { ...settings };
  if (!isPlainObject(base.hooks)) return base;
  const source = base.hooks as Record<string, unknown>;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!groupListHasOurs(groups)) { hooks[event] = groups; continue; } // nothing of ours here: untouched
    const kept = stripOurs(groups);
    if (kept.length > 0) hooks[event] = kept; // else prune the event entirely
  }
  if (Object.keys(hooks).length > 0) base.hooks = hooks; else delete base.hooks;
  return base;
}

const RC_FILES = [".bashrc", ".zshrc"];

const merge = (a: InstallReport, b: InstallReport): InstallReport =>
  ({ changed: [...a.changed, ...b.changed], skipped: [...a.skipped, ...b.skipped] });

const SETTINGS_REL = join(".claude", "settings.json");
const settingsText = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

type SettingsRead =
  | { kind: "missing" }
  | { kind: "bad"; note: string }
  | { kind: "ok"; text: string; value: Record<string, unknown> };

/** Read a home's settings.json: missing, unreadable-but-not-JSON (or not a JSON object, which we
 * also refuse to overwrite), or a parsed object alongside the original text (so a rewrite that
 * changes nothing is skipped, and a bad file is left byte-for-byte). */
function readSettings(path: string): SettingsRead {
  if (!existsSync(path)) return { kind: "missing" };
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { kind: "bad", note: `${path} (settings.json isn't valid JSON — left untouched)` }; }
  if (!isPlainObject(value)) return { kind: "bad", note: `${path} (settings.json isn't a JSON object — left untouched)` };
  return { kind: "ok", text, value };
}

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
  // The four mirror hooks. backgroundTools:true per the spike: only a detached tool hook keeps
  // session latency at zero (CC blocks a tool on its PreToolUse hook, spike (f)).
  const settings = join(home, SETTINGS_REL);
  const st = readSettings(settings);
  if (st.kind === "bad") report.skipped.push(st.note);
  else {
    const out = settingsText(mergeHookSettings(st.kind === "missing" ? {} : st.value, hookEntries(true)));
    if (st.kind !== "ok" || out !== st.text) { writeFileSync(settings, out); report.changed.push(settings); }
    else report.skipped.push(settings);
  }
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
  // Take the four mirror hooks back out, leaving everything else in settings.json exactly.
  const settings = join(home, SETTINGS_REL);
  const st = readSettings(settings);
  if (st.kind === "bad") report.skipped.push(st.note);
  else if (st.kind === "missing") report.skipped.push(settings);
  else {
    const out = settingsText(removeHookSettings(st.value));
    if (out !== st.text) { writeFileSync(settings, out); report.changed.push(settings); }
    else report.skipped.push(settings);
  }
  return merge(report, uninstallShim(home));
}
