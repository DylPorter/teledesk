/** claude-telegram daemon entry: `npm start` (or the systemd unit). Reads .env from the repo
 * folder: TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID (the owner's Telegram user id). */
import { join } from "node:path";
import { config } from "dotenv";
import { z } from "zod";
import { DeskDaemon } from "./daemon.js";
import { deskPaths, REPO_ROOT } from "./paths.js";

config({ path: join(REPO_ROOT, ".env"), quiet: true });

/** Exit code for errors a restart can't fix (bad config, rejected token): the unit doesn't restart on it. */
const CONFIG_ERROR = 78;

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_ID: z.string().regex(/^\d+$/, "must be a numeric Telegram user id"),
});
const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  // Names only: never the values.
  for (const i of parsed.error.issues) {
    const name = String(i.path[0]);
    process.stderr.write(`claude-telegram: ${name} ${process.env[name] ? i.message : "is missing"} (set it in .env)\n`);
  }
  process.exit(CONFIG_ERROR);
}

const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
const daemon = new DeskDaemon({
  token: parsed.data.TELEGRAM_BOT_TOKEN, ownerId: parsed.data.TELEGRAM_ALLOWED_USER_ID, paths: deskPaths(), log,
  onFatal: () => { void daemon.stop().finally(() => process.exit(CONFIG_ERROR)); },
});

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log(`claude-telegram: stopping (${sig})`);
  setTimeout(() => process.exit(0), 5000).unref();
  void daemon.stop().finally(() => process.exit(0));
};
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => stop(s));

try { await daemon.start(); }
catch (e) { log(`claude-telegram: couldn't start: ${(e as Error).message}`); process.exit(CONFIG_ERROR); }
