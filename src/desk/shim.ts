/** `teledesk install --shim`: a `claude` on PATH that hands interactive sessions to
 * `teledesk code`, so the desk travels with the executable instead of with one shell's
 * ~/.bashrc. A shell *function* only exists in shells that read the rc file after it was
 * written; PATH lookup is how every process finds a binary — pre-existing tmux panes,
 * `sh -c`, systemd user units, the IDE. That is the gap this closes.
 *
 * Recursion is the hazard: `teledesk code` itself spawns `claude`, so the shim must be
 * transparent to its own children. Two guards do that, and neither is clever — `TELEDESK`
 * says "inside a desk session", the shim's own variable says "a shim or wrapper started me".
 * When either is set the shim execs the real binary and steps out of the way.
 *
 * Lives in `~/bin` rather than replacing `~/.local/bin/claude`, because that one is a symlink
 * the Claude Code updater rewrites on every auto-update; `~/bin` is yours and precedes it. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NOT_INTERACTIVE, SUBCOMMANDS } from "./argv.js";
import type { InstallReport } from "./install.js";

/** Marks this file as ours: install refuses to touch a `claude` without it, uninstall only
 * removes a file with it. */
export const SHIM_MARKER = "teledesk-path-shim";

/** Set by the shim before handing off, and by the launcher on the session it spawns: "don't
 * wrap me again". */
export const ENV_SHIM = "TELEDESK_SHIM";

/** The desk-session guard, spelled the same way here so the drift is a failing test rather than
 * a silent loop. The real one is `ENV_GUARD` in channel.ts, which this file deliberately does
 * not import (it would drag the MCP SDK into `teledesk install`). */
export const ENV_SESSION = "TELEDESK";

export const SHIM_REL = join("bin", "claude");

/** The shell mirror of `interactive()` in argv.ts, generated from the same token lists. POSIX sh
 * only, and deliberately structured to fail *toward* wrapping: anything it cannot classify it
 * hands to `teledesk code`, which re-decides in TypeScript. A wrong "no" would deny the desk to an
 * interactive session; a wrong "yes" only costs a node boot. So the fast path is allowed to be
 * conservative, and the differential test in tests/shim.test.ts pins where it isn't. */
export function shellClassifier(): string[] {
  const words = (xs: readonly string[]) => xs.join(" ");
  return [
    "# Generated from src/desk/argv.ts by `teledesk install --shim` — do not edit here.",
    `NOTINT="${words(NOT_INTERACTIVE)}"`,
    `SUBS="${words(SUBCOMMANDS)}"`,
    "interactive() {",
    "  first=''",
    '  for a in "$@"; do',
    '    [ "$a" = "--" ] && return 0',
    '    tok=${a%%=*}',
    '    for n in $NOTINT; do [ "$tok" = "$n" ] && return 1; done',
    '    case $a in',
    '      -[a-zA-Z][a-zA-Z]*) case $a in *p*|*v*|*h*) return 1 ;; esac ;;',
    '    esac',
    '    if [ -z "$first" ]; then case $a in -*) ;; *) first=$a ;; esac; fi',
    '    if [ -n "$first" ]; then for s in $SUBS; do [ "$first" = "$s" ] && return 1; done; fi',
    "  done",
    "  return 0",
    "}",
  ];
}

/** The script. POSIX sh, no bash-isms, no absolute paths baked in (it resolves at run time). */
export function shimScript(): string {
  const lines = [
    "#!/bin/sh",
    "# " + SHIM_MARKER + " — written by `teledesk install --shim`; `teledesk uninstall` removes it.",
    "# Interactive claude gets the desk (its topic opens with /desk); everything else — and",
    "# anything a desk session or this script itself started — goes straight to the real binary.",
    `SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")`,
    "",
    ...shellClassifier(),
    "",
    "# The first claude on PATH that is not this script, then the known install locations.",
    "real_claude() {",
    '  oldIFS=$IFS; IFS=":"',
    "  for d in $PATH; do",
    '    [ -n "$d" ] || d=.',
    '    c="$d/claude"',
    '    [ -x "$c" ] || continue',
    '    r=$(readlink -f "$c" 2>/dev/null || echo "$c")',
    '    [ "$r" = "$SELF" ] && continue',
    '    printf "%s" "$c"; IFS=$oldIFS; return 0',
    "  done",
    "  IFS=$oldIFS",
    '  c="$HOME/.local/bin/claude"',
    '  [ -x "$c" ] && { printf "%s" "$c"; return 0; }',
    '  v=$(ls "$HOME/.local/share/claude/versions" 2>/dev/null | sort -V | tail -1)',
    '  [ -n "$v" ] && [ -x "$HOME/.local/share/claude/versions/$v" ] && { printf "%s" "$HOME/.local/share/claude/versions/$v"; return 0; }',
    "  return 1",
    "}",
    "",
    "# Already wrapped, or already inside a desk session: step out of the way.",
    `if [ -n "\${${ENV_SHIM}}" ] || [ -n "\${${ENV_SESSION}}" ]; then`,
    '  c=$(real_claude) || { echo "teledesk shim: no claude to run besides this script." >&2; exit 127; }',
    '  exec "$c" "$@"',
    "fi",
    "",
    "# Print mode, --version, a subcommand: there is no session to desk, so run it as asked",
    "# without booting node to be told the same thing (teledesk#18).",
    "interactive \"$@\" || {",
    '  c=$(real_claude) || { echo "teledesk shim: no claude to run besides this script." >&2; exit 127; }',
    '  exec "$c" "$@"',
    "}",
    "",
    "# No daemon-side wrapper installed: never block the editor.",
    "command -v teledesk >/dev/null 2>&1 || {",
    '  c=$(real_claude) || { echo "teledesk shim: neither teledesk nor claude is on PATH." >&2; exit 127; }',
    '  exec "$c" "$@"',
    "}",
    "",
    ENV_SHIM + "=1",
    "export " + ENV_SHIM,
    'exec teledesk code "$@"',
  ];
  return lines.join("\n") + "\n";
}

export const shimPath = (home = homedir()): string => join(home, SHIM_REL);

/** Whether a file at that path is one we wrote. */
function ours(file: string): boolean {
  try { return readFileSync(file, "utf8").includes(SHIM_MARKER); } catch { return false; }
}

/** Write `~/bin/claude`. A claude that isn't ours is left alone and reported as skipped. */
export function installShim(home = homedir()): InstallReport {
  const file = shimPath(home);
  if (existsSync(file)) {
    if (!ours(file)) return { changed: [], skipped: [file] };
    if (readFileSync(file, "utf8") === shimScript()) return { changed: [], skipped: [file] };
  } else mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(file, shimScript(), { mode: 0o755 });
  chmodSync(file, 0o755); // writeFileSync keeps an existing file's mode; the bit must hold.
  return { changed: [file], skipped: [] };
}

/** Remove it — only if it's ours. */
export function uninstallShim(home = homedir()): InstallReport {
  const file = shimPath(home);
  if (!existsSync(file)) return { changed: [], skipped: [] };
  if (!ours(file)) return { changed: [], skipped: [file] };
  rmSync(file);
  return { changed: [file], skipped: [] };
}
