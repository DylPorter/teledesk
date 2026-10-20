/** bin/teledesk is the entry point for the desk, and dispatches five subcommands. The code
 * command starts Claude Code desk-capable, so its topic can be opened with /desk. The install
 * command makes an ordinary claude invocation desk-capable and adds the /desk slash command;
 * with the --shim flag it also drops a desk-aware claude in ~/bin, which is the part that
 * reaches shells that never read the rc file. The desk-channel command is the channel server
 * Claude Code itself runs for a wrapped session, and is never run by hand. The mirror-hook
 * command is the hook entrypoint Claude Code runs: hook JSON in on stdin, mirror lines to the
 * daemon, exit 0 whatever happens. The daemon is a separate entry point (src/daemon.ts).
 * Each branch imports only what it needs. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deskPaths, ensureDataDir, migrateLegacyDataDir, REPO_ROOT } from "./paths.js";

const USAGE = `teledesk — your Claude Code sessions in Telegram topics

  teledesk code [claude args…]   start Claude Code desk-capable (its topic opens with /desk)
  teledesk install               make plain \`claude\` desk-capable: add the /desk command + the mirror hooks
  teledesk install --shim        also put a desk-aware \`claude\` in ~/bin, which reaches shells
                                 that never read the rc file (old tmux panes, sh -c, systemd)
  teledesk uninstall             remove what install added
  teledesk desk-channel          the channel server Claude Code runs for \`code\` (not run by hand)
  teledesk mirror-hook           the hook entrypoint Claude Code runs (not run by hand)

The daemon itself runs with \`npm start\` (or the systemd unit).`;

/** Everything piped in on stdin, as one string. Ends on EOF; a read error is just a short read. */
function readStdin(): Promise<string> {
  return new Promise((res) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => res(s));
    process.stdin.on("close", () => res(s));
    process.stdin.on("error", () => res(s));
  });
}

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
    const { shimPath } = await import("./desk/shim.js");
    const shim = cmd === "install" && args.includes("--shim");
    const r = cmd === "install" ? install(undefined, { shim }) : uninstall();
    for (const f of r.changed) console.log(`${cmd === "install" ? "updated" : "cleaned"}: ${f}`);
    for (const f of r.skipped) console.log(`skipped: ${f}`);
    // A ~/bin/claude that isn't ours is the one failure that would otherwise read as success.
    if (cmd === "install" && shim && r.skipped.includes(shimPath())) {
      console.log(`not touched: ${shimPath()} already exists and isn't a teledesk shim — move it, or install without --shim.`);
      process.exitCode = 1;
    }
    if (cmd === "install") console.log(shim
      ? "Done: \`claude\` is desk-capable from now on, including in shells and panes opened before this. /desk inside a session opens its Telegram topic."
      : "Open a new terminal (or `source ~/.bashrc`), start claude as usual, then /desk inside a session opens its Telegram topic.");
    return;
  }
  if (cmd === "desk-channel") {
    const { runDeskChannel } = await import("./desk/channel.js");
    const p = deskPaths();
    ensureDataDir(p.dataDir);
    process.exitCode = await runDeskChannel(p.socket);
    return;
  }
  if (cmd === "mirror-hook") {
    // The hook runner reads a non-zero exit or an escaped throw as a broken hook, so this
    // branch wraps everything — including its own module loading — in a silent exit 0.
    try {
      const { runMirrorHook } = await import("./desk/mirror-hook.js");
      // Run by hand with no pipe there is nothing to read; the hook always pipes, so just leave.
      if (process.stdin.isTTY) process.exit(0);
      process.exit(await runMirrorHook(await readStdin(), process.env, deskPaths().socket));
    } catch { process.exit(0); }
  }
  console.log(USAGE);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
}

main().catch((e) => { process.stderr.write(`teledesk: ${(e as Error).message}\n`); process.exit(1); });
