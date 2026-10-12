/** `claude-telegram code [claude args…]`: start interactive Claude Code with the desk channel
 * loaded. Custom channels aren't on the research-preview allowlist, so it's loaded
 * with --dangerously-load-development-channels (Claude Code asks to confirm), from an
 * MCP config passed with --mcp-config. */
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { CHANNEL_NAME, ENV_GUARD } from "./channel.js";

/** The MCP config that defines the channel server. No env here: the guard variable comes
 * only from the launcher's own environment, so the file alone doesn't enable the channel. */
export function deskMcpConfig(command: string, args: string[]): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { [CHANNEL_NAME]: { type: "stdio", command, args } } };
}

/** The reply tool, pre-allowed so each answer to the owner doesn't need a permission tap. */
export const REPLY_TOOL = `mcp__${CHANNEL_NAME}__reply`;

/** These flags take several values, so they're given in --flag=value form: a prompt or other
 * argument after them can't be swallowed as another config file, channel or tool. */
export function claudeArgs(configFile: string, userArgs: string[]): string[] {
  return [`--mcp-config=${configFile}`, `--dangerously-load-development-channels=server:${CHANNEL_NAME}`, `--allowedTools=${REPLY_TOOL}`, ...userArgs];
}

/** claude's subcommands (claude --help, plus older names): none of them is an interactive session. */
const SUBCOMMANDS = new Set(["agents", "attach", "auth", "auto-mode", "config", "doctor", "gateway", "help", "import", "install", "kill", "logs", "mcp",
  "migrate-installer", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "ultrareview", "update", "upgrade"]);
/** Flags that mean no interactive session in this terminal (print mode, its formats, version, help, background). */
const NOT_INTERACTIVE = new Set(["-p", "--print", "--output-format", "--input-format", "-v", "--version", "-h", "--help", "--bg", "--background"]);

/** Whether these claude arguments start an interactive session, the only kind that gets the desk
 * channel: print mode ignores the channel flag, so the server would start with nothing to talk to. */
export function interactive(args: string[]): boolean {
  let first: string | undefined;
  for (const a of args) {
    if (a === "--") break;
    if (NOT_INTERACTIVE.has(a.split("=")[0])) return false;
    // Combined short flags, e.g. -cp.
    if (/^-[a-zA-Z]{2,}$/.test(a) && /[pvh]/.test(a.slice(1))) return false;
    if (!a.startsWith("-") && first === undefined) first = a;
  }
  return first === undefined || !SUBCOMMANDS.has(first);
}

export function writeDeskConfig(file: string, command: string, args: string[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(deskMcpConfig(command, args), null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Run claude in this terminal and return its exit code. With `desk: false`, plain claude
 * (and the guard variable is removed, in case this runs inside a desk session). */
export function runClaude(o: { args: string[]; desk: boolean; claude?: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  if (o.desk) env[ENV_GUARD] = "1"; else delete env[ENV_GUARD];
  const child = spawn(o.claude ?? "claude", o.args, { stdio: "inherit", env });
  // Ctrl-C belongs to Claude Code; termination is passed on.
  const onInt = () => { /* claude handles it */ };
  const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
  const onTerm = forward("SIGTERM"), onHup = forward("SIGHUP");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup);
  return new Promise<number>((resolve) => {
    const done = (code: number) => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("SIGHUP", onHup); resolve(code); };
    child.on("error", (e) => {
      process.stderr.write((e as NodeJS.ErrnoException).code === "ENOENT" ? "claude-telegram code: `claude` isn't on your PATH.\n" : `claude-telegram code: couldn't start claude: ${e.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 0)));
  });
}
