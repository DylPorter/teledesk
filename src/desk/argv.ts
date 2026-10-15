/** The single classifier for "do these claude arguments open an interactive session?".
 *
 * Only an interactive session can use the desk: a print run ends before anyone can write to the
 * topic, and a subcommand never opens a prompt at all. Two places have to answer this — the
 * launcher (`teledesk code`) and the PATH shim (`~/bin/claude`) — and the shim has to answer it
 * in shell, because booting node to be told "not for you" costs automation ~0.7s per invocation
 * (teledesk#18). So the shim's copy of these lists is GENERATED from here rather than retyped by
 * hand, and tests/shim.test.ts asserts the shell answer matches this one across every vector.
 * A rule duplicated by hand drifts silently; a rule generated from one source can't. */

/** claude's subcommands (claude --help, plus older names): none of them is an interactive session. */
export const SUBCOMMANDS: readonly string[] = ["agents", "attach", "auth", "auto-mode", "config", "doctor", "gateway", "help", "import", "install", "kill", "logs", "mcp",
  "migrate-installer", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "ultrareview", "update", "upgrade"];

/** Flags that mean no interactive session in this terminal (print mode, its formats, version, help, background). */
export const NOT_INTERACTIVE: readonly string[] = ["-p", "--print", "--output-format", "--input-format", "-v", "--version", "-h", "--help", "--bg", "--background"];

/** Whether these claude arguments start an interactive session, the only kind that gets the desk
 * channel: print mode ignores the channel flag, so the server would start with nothing to talk to. */
export function interactive(args: string[]): boolean {
  let first: string | undefined;
  for (const a of args) {
    if (a === "--") break;
    if (NOT_INTERACTIVE.includes(a.split("=")[0]!)) return false;
    // Combined short flags, e.g. -cp.
    if (/^-[a-zA-Z]{2,}$/.test(a) && /[pvh]/.test(a.slice(1))) return false;
    if (!a.startsWith("-") && first === undefined) first = a;
  }
  return first === undefined || !SUBCOMMANDS.includes(first);
}
