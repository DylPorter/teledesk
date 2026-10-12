/**
 * The outbound /push server's env wiring.
 *
 * Everything that answers an HTTP request lives in `push-routes.ts`; this file
 * exists to read `env` and start listening. Keeping the two apart is what lets
 * the routing be tested at all — importing anything from here parses
 * `process.env` and requires a bot token.
 *
 * Security: bound to 127.0.0.1 only + shared-secret header. No external
 * exposure. (The secret comparison is a plain `!==` rather than a
 * constant-time compare — pre-existing, and left alone: the listener is
 * loopback-only and the secret is 32 hex characters.)
 */

import { createPushServer } from "./push-routes.js";
import { loadDocumentRegistry } from "./documents.js";
import { env } from "./env.js";
import type { Bot } from "grammy";

/**
 * Start an HTTP server on localhost that lets external processes (signal-brief
 * orchestrators, scheduled scripts) push messages and board documents to the
 * bot's allowed user.
 *
 * Each entry in a /push `messages` array becomes a separate Telegram message
 * (one chat bubble). Long entries are auto-split at the 4000-char hard limit.
 * Sender controls logical chunking; this endpoint never merges.
 */
export function startPushServer(bot: Bot): void {
  const port = env.PUSH_PORT;

  // Resolved once, at start, and DELIBERATELY not fatal. `loadDocumentRegistry`
  // turns a malformed PUSH_DOCUMENTS into an empty allowlist plus a reason
  // rather than an exception: this runs before `bot.start()`, and the unit
  // restarts on failure with no StartLimit override, so a throw here would take
  // the whole bot down over a typo in an optional feature and leave it down.
  const { registry, problem } = loadDocumentRegistry(env.PUSH_DOCUMENTS);
  if (problem) {
    console.error(`[push] document delivery DISABLED — ${problem}`);
  }

  const server = createPushServer(bot, {
    chatId: env.TELEGRAM_ALLOWED_USER_ID,
    secret: env.PUSH_SECRET,
    documents: registry,
    documentsProblem: problem,
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(
      `[push] listening on 127.0.0.1:${port} (documents: ${
        registry.size > 0 ? [...registry.keys()].join(", ") : "disabled"
      })`,
    );
  });
}
