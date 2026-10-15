/** `teledesk code [claude args…]`: start interactive Claude Code with the desk channel
 * loaded. Custom channels aren't on the research-preview allowlist, so it's loaded
 * with --dangerously-load-development-channels (Claude Code asks to confirm), from an
 * MCP config passed with --mcp-config. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { CHANNEL_NAME, ENV_GUARD } from "./channel.js";
import { ENV_SHIM } from "./shim.js";

/** The MCP config that defines the channel server. No env here: the guard variable comes
 * only from the launcher's own environment, so the file alone doesn't enable the channel. */
export function deskMcpConfig(command: string, args: string[]): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { [CHANNEL_NAME]: { type: "stdio", command, args } } };
}

/** The reply tool, pre-allowed so each answer to the owner doesn't need a permission tap. */
export const REPLY_TOOL = `mcp__${CHANNEL_NAME}__reply`;
/** Reply plus the desk on/off tools (/desk): using the desk itself never needs a tap. */
export const DESK_TOOLS = [REPLY_TOOL, `mcp__${CHANNEL_NAME}__desk_on`, `mcp__${CHANNEL_NAME}__desk_off`].join(",");

/** These flags take several values, so they're given in --flag=value form: a prompt or other
 * argument after them can't be swallowed as another config file, channel or tool. */
export function claudeArgs(configFile: string, userArgs: string[]): string[] {
  return [`--mcp-config=${configFile}`, `--dangerously-load-development-channels=server:${CHANNEL_NAME}`, `--allowedTools=${DESK_TOOLS}`, ...userArgs];
}

/** The interactive/print/subcommand classifier now lives in argv.ts, shared with the PATH shim
 * (which generates its shell test from the same lists). Re-exported so callers and tests that
 * import it from here keep working. */
export { interactive } from "./argv.js";

export function writeDeskConfig(file: string, command: string, args: string[]): void {
  // A fresh name, created exclusively: never written through something already there.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(deskMcpConfig(command, args), null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

/** Claude Code cleans and masks what it relays to channels from this version on. */
export const MIN_CLAUDE = "2.1.234";

/** Whether version a (e.g. "2.1.296") is older than b. */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

/** The installed claude's version, if it can be read quickly. */
export function claudeVersion(claude = "claude"): string | undefined {
  try { return /(\d+\.\d+\.\d+)/.exec(execFileSync(claude, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }))?.[1]; }
  catch { return undefined; }
}

/** Run claude in this terminal and return its exit code. With `desk: false`, plain claude
 * (and the guard variable is removed, in case this runs inside a desk session). */
export function runClaude(o: { args: string[]; desk: boolean; claude?: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  if (o.desk) env[ENV_GUARD] = "1"; else delete env[ENV_GUARD];
  // This child must be the real binary. With the PATH shim installed (`teledesk install --shim`),
  // spawning the bare name `claude` would find the shim again, and the shim would hand back to
  // `teledesk code` — an infinite loop that this one variable ends. Set on both paths: the plain
  // one too, because `claude --version` from here must not become another wrapped session.
  env[ENV_SHIM] = "1";
  const child = spawn(o.claude ?? "claude", o.args, { stdio: "inherit", env });
  // Ctrl-C belongs to Claude Code; termination is passed on.
  const onInt = () => { /* claude handles it */ };
  const forward = (sig: NodeJS.Signals) => () => { child.kill(sig); };
  const onTerm = forward("SIGTERM"), onHup = forward("SIGHUP");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup);
  return new Promise<number>((resolve) => {
    const done = (code: number) => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("SIGHUP", onHup); resolve(code); };
    child.on("error", (e) => {
      process.stderr.write((e as NodeJS.ErrnoException).code === "ENOENT" ? "teledesk code: `claude` isn't on your PATH.\n" : `teledesk code: couldn't start claude: ${e.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 0)));
  });
}
