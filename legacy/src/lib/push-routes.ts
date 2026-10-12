/**
 * The /push HTTP surface, with no dependency on `env`.
 *
 * Split out of `push.ts` so it can be driven over a real loopback socket in a
 * test. It could not be before: `push.ts` imports `./env.js`, which parses
 * `process.env` (and loads `.env`) at module load, so merely importing the
 * routing pulled in a bot token and a required-var check. Three of the four
 * defects found in the first review round lived in this file precisely because
 * nothing could reach it — `push.ts` now holds only the env wiring.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GrammyError, InputFile } from "grammy";
import {
  DocumentError,
  documentFilename,
  readBoardFile,
  resolveBoardPath,
  assertCaptionFits,
} from "./documents.js";

/**
 * The slice of a grammY `Bot` these routes use. Structural on purpose: a test
 * passes a plain object, and a real `Bot` satisfies it without a cast.
 */
export interface PushBot {
  api: {
    sendMessage(chatId: number, text: string, other?: never): Promise<{ message_id: number }>;
    sendDocument(
      chatId: number,
      document: InputFile,
      other?: never,
    ): Promise<{ message_id: number }>;
  };
}

export interface PushServerConfig {
  chatId: number;
  secret: string;
  /** The `key -> absolute path` allowlist. Empty disables /push-document. */
  documents: Map<string, string>;
  /** Why the allowlist is empty, when it is empty because of a config typo. */
  documentsProblem?: string | null;
}

interface PushPayload {
  messages: string[];
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  disablePreview?: boolean;
  delayMs?: number;
}

interface PushDocumentPayload {
  /** A KEY from PUSH_DOCUMENTS. Never a path — see lib/documents.ts. */
  board: string;
  caption?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}

const MAX_TELEGRAM_LEN = 4000;

export function splitForTelegram(text: string, size = MAX_TELEGRAM_LEN): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let split = remaining.lastIndexOf("\n", size);
    if (split < size / 2) split = size;
    parts.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks).toString("utf8");
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Describe ANY error without quoting its message.
 *
 * Used by the outer catch, where the error could be almost anything — most
 * consequentially an `fs` error from `readBoardFile`'s `readFile`. That call
 * runs after the `stat` guard and is NOT wrapped in a `DocumentError`, so an
 * EACCES, an EISDIR, or the board being swapped between the stat and the read
 * (a live race: the generator rewrites that exact file) fell straight through
 * to a body of `(err as Error).message` — which for an fs error is the
 * configured ABSOLUTE PATH, verbatim. From there it reached the journal, and
 * the Telegram bubble via the client's `resp.text[:200]` relay. Exactly the
 * leak the 502 branch below was fixed to close, one catch further out.
 *
 * `code` is safe to name — it is a short constant like `EACCES`, never a path —
 * and it is the only part a reader can act on.
 */
function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return typeof code === "string" ? `${name} (${code})` : name;
}

/**
 * Describe a failed Telegram call WITHOUT quoting the underlying error text.
 *
 * The message on a transport failure is whatever the HTTP stack produced, and
 * that can be a full request URL — which, for the Bot API, contains the bot
 * token in its path. This string goes to the journal in plaintext AND back to
 * the caller, which relays it into a Telegram bubble. The 4xx branch of this
 * handler was already careful never to echo a configured path; this branch was
 * not, and pasted `(err as Error).message` verbatim into both.
 *
 * So: classification only. `GrammyError` means Telegram itself answered
 * `ok: false`, and its `error_code` is a number that is genuinely actionable.
 * Anything else is named by its constructor and nothing more.
 */
function describeSendFailure(err: unknown): string {
  if (err instanceof GrammyError) {
    return `Telegram rejected the upload (error_code ${err.error_code})`;
  }
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return `could not reach Telegram (${name})`;
}

/**
 * POST /push-document — send one allowlisted file as a Telegram document.
 *
 * The caption carries the run's summary, which is what keeps this to ONE
 * notification: the caller sends its summary bubble AS the caption instead of
 * as a separate message, rather than sending both.
 *
 * Auth and the localhost bind are already enforced by the caller.
 */
async function handlePushDocument(
  bot: PushBot,
  config: PushServerConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<PushDocumentPayload>;

  let path: string;
  let filename: string;
  let caption: string | undefined;
  let parseMode: PushDocumentPayload["parseMode"];
  let file: Buffer;
  try {
    path = resolveBoardPath(config.documents, body?.board, config.documentsProblem ?? null);
    // The TRIMMED key, not the raw field: `documentFilename` slugifies its
    // fallback too, but handing it the raw body value was how untrimmed caller
    // input reached a filename in the first place.
    filename = documentFilename(path, (body!.board as string).trim());
    if (body?.caption !== undefined && typeof body.caption !== "string") {
      // Said out loud rather than coerced or dropped. A caption that silently
      // vanished would deliver the board with no summary and still answer 200,
      // which is a lost bubble reported as a success.
      throw new DocumentError(400, "caption must be a string when present");
    }
    caption = body?.caption;
    if (caption !== undefined) assertCaptionFits(caption);
    parseMode = caption !== undefined ? body?.parseMode : undefined;
    file = await readBoardFile(path);
  } catch (err) {
    if (err instanceof DocumentError) {
      // Logged WITHOUT the path: the configured location is the operator's
      // vault, and this line goes to the journal.
      console.error(`[push] document rejected (${err.status}): ${err.message}`);
      writeJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }

  const ok = (message_id: number, parseModeDropped = false) =>
    writeJson(res, 200, {
      sent: [message_id],
      board: body?.board,
      filename,
      bytes: file.byteLength,
      ...(parseModeDropped ? { parseModeDropped: true } : {}),
    });

  try {
    const msg = await bot.api.sendDocument(config.chatId, new InputFile(file, filename), {
      caption,
      parse_mode: parseMode,
    } as never);
    ok(msg.message_id);
    return;
  } catch (err) {
    // The retry is allowed ONLY when the failure proves nothing was sent.
    //
    // /push retries a text message blind, which is survivable for text. It is
    // not survivable here: a document that already reached Telegram and then
    // failed on the response read would be uploaded TWICE, the caller would see
    // 200, and the run would deliver two boards — the exact bubble-count
    // regression this whole shape exists to prevent, arriving through a
    // success path nobody was watching.
    //
    // `GrammyError` alone is NOT a safe discriminator, though the first attempt
    // at this assumed it was ("Telegram answered ok:false, so no message
    // exists"). grammY's `callApi` calls `res.json()` unconditionally and never
    // looks at the HTTP status (core/client.js:50), so Telegram's own 5xx and
    // 429 responses — which arrive as `ok: false` JSON envelopes — become
    // `GrammyError` too. Those can follow a backend that ALREADY accepted the
    // upload, so retrying on them re-opened the double-send through the success
    // path: error_code 500/502/429 each produced two uploads and a 200.
    //
    // `error_code === 400` is the discriminator that actually holds. A 400 is
    // Telegram refusing to accept the request at all, so nothing was created.
    // It is also exactly the case the retry exists for — "can't parse entities"
    // is a 400 — so narrowing this costs the legitimate path nothing. A 429 is
    // excluded on its own merits as well: dropping a parse mode cannot fix a
    // flood-wait, and this ignores `retry_after`.
    //
    // The retry also has to have something to change — dropping a `parse_mode`
    // that was never set reissues a byte-identical request.
    const retryable =
      err instanceof GrammyError &&
      err.error_code === 400 &&
      caption !== undefined &&
      parseMode !== undefined;
    if (retryable) {
      try {
        const msg = await bot.api.sendDocument(config.chatId, new InputFile(file, filename), {
          caption,
        } as never);
        ok(msg.message_id, true);
        return;
      } catch (err2) {
        err = err2;
      }
    }
    const reason = describeSendFailure(err);
    console.error(`[push] sendDocument failed for ${filename}: ${reason}`);
    // 502, not 500: the caller distinguishes "Telegram refused it" from "your
    // request was wrong", and falls back to a plain text bubble either way.
    writeJson(res, 502, { error: `sendDocument failed: ${reason}` });
  }
}

async function handlePush(
  bot: PushBot,
  config: PushServerConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<PushPayload>;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    writeJson(res, 400, { error: "messages[] required" });
    return;
  }

  const parseMode = body.parseMode;
  const disablePreview = body.disablePreview !== false;
  const delayMs = Math.max(0, Math.min(5000, body.delayMs ?? 350));

  const sent: number[] = [];
  const failed: { index: number; error: string }[] = [];

  for (let i = 0; i < body.messages.length; i++) {
    const text = String(body.messages[i] ?? "").trim();
    if (!text) continue;
    for (const part of splitForTelegram(text)) {
      try {
        const msg = await bot.api.sendMessage(config.chatId, part, {
          parse_mode: parseMode,
          link_preview_options: { is_disabled: disablePreview },
        } as never);
        sent.push(msg.message_id);
      } catch (err) {
        // Retry once without parse_mode in case Markdown failed.
        try {
          const msg = await bot.api.sendMessage(config.chatId, part, {
            link_preview_options: { is_disabled: disablePreview },
          } as never);
          sent.push(msg.message_id);
        } catch (err2) {
          failed.push({ index: i, error: describeSendFailure(err2) });
        }
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  writeJson(res, 200, { sent, failed });
}

/**
 * Build (but do not listen on) the push server.
 *
 * Endpoints:
 *   GET  /healthz                 — liveness probe
 *   POST /push                    — { messages: string[], parseMode?, disablePreview?, delayMs? }
 *   POST /push-document           — { board: <PUSH_DOCUMENTS key>, caption?, parseMode? }
 *
 * `/push-document` sends ONE configured file as a Telegram document. The caller
 * names a key, not a path, so the endpoint cannot read arbitrary files; the
 * allowlist lives in this process's env and is empty (endpoint disabled) unless
 * the operator sets PUSH_DOCUMENTS.
 *
 * The secret check runs BEFORE the route split, so an unauthenticated request
 * cannot even learn which routes exist.
 */
export function createPushServer(bot: PushBot, config: PushServerConfig): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        writeJson(res, 200, { ok: true, ts: new Date().toISOString() });
        return;
      }

      if (req.method !== "POST" || (req.url !== "/push" && req.url !== "/push-document")) {
        writeJson(res, 404, { error: "not found" });
        return;
      }

      const auth = req.headers["x-push-secret"];
      if (auth !== config.secret) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.url === "/push-document") {
        await handlePushDocument(bot, config, req, res);
        return;
      }

      await handlePush(bot, config, req, res);
    } catch (err) {
      // Classified, never echoed — and the error OBJECT is never logged either,
      // because its `path`/`stack` carry the same absolute path the message
      // does. See `describeError`.
      const reason = describeError(err);
      console.error(`[push] unhandled error on ${req.method} ${req.url}: ${reason}`);
      writeJson(res, 500, { error: `request failed: ${reason}` });
    }
  });
}
