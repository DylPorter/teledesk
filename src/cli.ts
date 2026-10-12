/** bin/claude-telegram: `code [claude args…]` starts Claude Code with its own Telegram topic;
 * `desk-channel` is the channel server Claude Code runs for it (never by hand). Each
 * subcommand loads only what it needs. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deskPaths, ensureDataDir, REPO_ROOT } from "./paths.js";

const USAGE = `claude-telegram — your Claude Code sessions in Telegram topics

  claude-telegram code [claude args…]   start Claude Code with its own topic in your desk group
  claude-telegram desk-channel          the channel server Claude Code runs for \`code\` (not run by hand)

The daemon itself runs with \`npm start\` (or the systemd unit).`;

async function code(args: string[]): Promise<number> {
  const { claudeArgs, interactive, runClaude, writeDeskConfig } = await import("./desk/launcher.js");
  // -p runs, subcommands, --version…: plain claude, arguments untouched.
  if (!interactive(args)) return runClaude({ args, desk: false });
  const p = deskPaths();
  ensureDataDir(p.dataDir);
  if (!existsSync(p.socket)) process.stderr.write("claude-telegram code: the daemon isn't running; this session gets its topic once it starts.\n");
  writeDeskConfig(p.mcpConfig, join(REPO_ROOT, "bin", "claude-telegram"), ["desk-channel"]);
  return runClaude({ args: claudeArgs(p.mcpConfig, args), desk: true });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "code") { process.exitCode = await code(args); return; }
  if (cmd === "desk-channel") {
    const { runDeskChannel } = await import("./desk/channel.js");
    process.exitCode = await runDeskChannel(deskPaths().socket);
    return;
  }
  console.log(USAGE);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
}

main().catch((e) => { process.stderr.write(`claude-telegram: ${(e as Error).message}\n`); process.exit(1); });
