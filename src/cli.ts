/** bin/teledesk: `code [claude args…]` starts Claude Code desk-capable (its topic opens
 * with /desk); `install` makes plain `claude` desk-capable and adds the /desk command;
 * `desk-channel` is the channel server Claude Code runs for it (never by hand). Each
 * subcommand loads only what it needs. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deskPaths, ensureDataDir, migrateLegacyDataDir, REPO_ROOT } from "./paths.js";

const USAGE = `teledesk — your Claude Code sessions in Telegram topics

  teledesk code [claude args…]   start Claude Code desk-capable (its topic opens with /desk)
  teledesk install               make plain \`claude\` desk-capable + add the /desk command
  teledesk uninstall             remove what install added
  teledesk desk-channel          the channel server Claude Code runs for \`code\` (not run by hand)

The daemon itself runs with \`npm start\` (or the systemd unit).`;

async function code(args: string[]): Promise<number> {
  const { claudeArgs, claudeVersion, interactive, MIN_CLAUDE, olderThan, runClaude, writeDeskConfig } = await import("./desk/launcher.js");
  // -p runs, subcommands, --version…: plain claude, arguments untouched.
  if (!interactive(args)) return runClaude({ args, desk: false });
  const p = deskPaths();
  if (migrateLegacyDataDir(p)) process.stderr.write("teledesk: moved the data folder to " + p.dataDir + "\n");
  ensureDataDir(p.dataDir);
  if (!existsSync(p.socket)) process.stderr.write("teledesk code: the daemon isn't running; this session gets its topic once it starts.\n");
  const v = claudeVersion();
  if (v && olderThan(v, MIN_CLAUDE)) process.stderr.write(`teledesk code: Claude Code ${v} is older than ${MIN_CLAUDE}, which cleans and masks the permission prompts it relays. Update it before approving from Telegram.\n`);
  writeDeskConfig(p.mcpConfig, join(REPO_ROOT, "bin", "teledesk"), ["desk-channel"]);
  return runClaude({ args: claudeArgs(p.mcpConfig, args), desk: true });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "code") { process.exitCode = await code(args); return; }
  if (cmd === "install" || cmd === "uninstall") {
    const { install, uninstall } = await import("./desk/install.js");
    const r = cmd === "install" ? install() : uninstall();
    for (const f of r.changed) console.log(`${cmd === "install" ? "updated" : "cleaned"}: ${f}`);
    for (const f of r.skipped) console.log(`skipped: ${f}`);
    if (cmd === "install") console.log("Open a new terminal (or `source ~/.bashrc`), start claude as usual, then /desk inside a session opens its Telegram topic.");
    return;
  }
  if (cmd === "desk-channel") {
    const { runDeskChannel } = await import("./desk/channel.js");
    const p = deskPaths();
    ensureDataDir(p.dataDir);
    process.exitCode = await runDeskChannel(p.socket);
    return;
  }
  console.log(USAGE);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
}

main().catch((e) => { process.stderr.write(`teledesk: ${(e as Error).message}\n`); process.exit(1); });
