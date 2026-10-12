/**
 * Document delivery for /push — the allowlist, the filename, and the guards.
 *
 * Pure logic, deliberately separated from the HTTP handler so it can be tested
 * without standing up a server or a bot.
 *
 * The security shape: a caller names a KEY, never a path. Paths live only in
 * this process's environment (`PUSH_DOCUMENTS`), so the endpoint cannot be
 * turned into an arbitrary-file-read primitive by anything in the request
 * body. There is no traversal to sanitise because there is no caller-supplied
 * path component to traverse with.
 *
 * Unset `PUSH_DOCUMENTS` means the whole feature is OFF and the endpoint
 * refuses. That is the default, so a sibling deployment that never configures
 * it is unaffected by this file existing.
 */

import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";

/** Telegram's hard ceiling for a document uploaded by a bot. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/** Telegram's ceiling for a media caption. */
export const MAX_CAPTION_LEN = 1024;

/** Board keys are operator-chosen identifiers, not paths. */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * An error that carries the HTTP status the handler should answer with, so the
 * caller can tell "you asked for a board I do not serve" apart from "the file
 * is gone" apart from "the file is absurdly large". A single 500 for all three
 * is how a delivery failure turns into a quiet day.
 */
export class DocumentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

/**
 * A malformed allowlist. Thrown by the pure parser; `loadDocumentRegistry`
 * catches it so a typo cannot take the process down — see there.
 */
export class DocumentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentConfigError";
  }
}

/**
 * Parse `PUSH_DOCUMENTS` — a comma-separated list of `key=/absolute/path`.
 *
 * Undefined/blank yields an EMPTY registry, which the handler treats as
 * "document delivery not configured" and refuses. That is the default-off
 * requirement: nobody has to edit code, or even know this exists, to be
 * unaffected by it.
 *
 * Malformed entries throw rather than being silently skipped — a skipped entry
 * is a board that quietly never arrives. What the THROW is allowed to take
 * down is the subject of `loadDocumentRegistry`; it is not this function.
 *
 * Entries are identified by POSITION, never by echoing the raw text back. A
 * malformed entry is usually a mistyped path, and this message reaches both the
 * journal and (via the 503) the operator's digest bubble.
 *
 * Paths containing a comma are not expressible. That is a documented
 * limitation, not an oversight: the alternative (JSON in a .env) buys one
 * pathological filename at the cost of every hand-edit.
 */
export function parseDocumentRegistry(raw: string | undefined): Map<string, string> {
  const registry = new Map<string, string>();
  const text = (raw ?? "").trim();
  if (!text) return registry;

  const entries = text.split(",");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!.trim();
    if (!entry) continue;
    const at = `entry #${i + 1}`;

    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new DocumentConfigError(`PUSH_DOCUMENTS ${at} is not "key=/absolute/path"`);
    }

    const key = entry.slice(0, eq).trim();
    const path = entry.slice(eq + 1).trim();

    if (!KEY_RE.test(key)) {
      // The key is NOT echoed: a key that failed this test is arbitrary text,
      // and arbitrary text in a mistyped PUSH_DOCUMENTS is usually a path.
      throw new DocumentConfigError(`PUSH_DOCUMENTS ${at} has a key that is not ${KEY_RE.source}`);
    }
    // From here the key has matched KEY_RE, so it is a safe operator label and
    // naming it costs nothing.
    if (!path.startsWith("/")) {
      throw new DocumentConfigError(`PUSH_DOCUMENTS ${at} (${key}) must have an absolute path`);
    }
    if (path.includes("\0")) {
      throw new DocumentConfigError(`PUSH_DOCUMENTS ${at} (${key}) has a NUL byte in its path`);
    }
    if (registry.has(key)) {
      throw new DocumentConfigError(`PUSH_DOCUMENTS ${at} repeats the key ${key}`);
    }

    registry.set(key, path);
  }

  return registry;
}

/** What `loadDocumentRegistry` resolved: the allowlist, and why it is empty. */
export interface DocumentRegistry {
  registry: Map<string, string>;
  /** null when the config was fine (whether or not it was set). */
  problem: string | null;
}

/**
 * Resolve the allowlist for the running server, WITHOUT ever throwing.
 *
 * This is the difference between loud and fatal, and the distinction is the
 * whole reason the function exists. `parseDocumentRegistry` throwing on a typo
 * is right. Letting that throw escape into `startPushServer` was not: it runs
 * before `bot.start()`, and the unit carries `Restart=on-failure` with no
 * `StartLimit*` override, so systemd burns its default restart budget in
 * seconds and leaves the service `failed`. One bad character in an OPTIONAL,
 * default-off feature would take down chat, /push and every scheduled brief,
 * and keep them down until someone noticed by hand.
 *
 * So a malformed allowlist degrades exactly like every other failure in this
 * change: the feature turns itself off, the endpoint answers 503 with the
 * reason, and `push_with_board` puts that reason in the digest bubble. The
 * operator finds out from the thing he already reads, and still has a bot.
 */
export function loadDocumentRegistry(raw: string | undefined): DocumentRegistry {
  try {
    return { registry: parseDocumentRegistry(raw), problem: null };
  } catch (err) {
    if (err instanceof DocumentConfigError) {
      return { registry: new Map(), problem: err.message };
    }
    throw err;
  }
}

/**
 * The configured path for a key, or a DocumentError the handler can answer with.
 *
 * `problem` is `loadDocumentRegistry`'s: it turns an otherwise indistinguishable
 * "not configured" 503 into one that names the typo.
 */
export function resolveBoardPath(
  registry: Map<string, string>,
  board: unknown,
  problem: string | null = null,
): string {
  if (registry.size === 0) {
    throw new DocumentError(
      503,
      problem
        ? `document delivery disabled: ${problem}`
        : "document delivery not configured (PUSH_DOCUMENTS unset)",
    );
  }
  if (typeof board !== "string" || !board.trim()) {
    throw new DocumentError(400, "board (string) required");
  }
  const path = registry.get(board.trim());
  if (path === undefined) {
    // The KEYS are echoed (they are operator-chosen labels and this is a
    // localhost-only, secret-gated endpoint); the PATHS never are.
    throw new DocumentError(400, `unknown board — configured: ${[...registry.keys()].join(", ")}`);
  }
  return path;
}

/**
 * Reduce a string to something safe to put in an unquoted HTTP header value.
 * Everything outside `[a-z0-9._-]` collapses to a hyphen — spaces, quotes,
 * semicolons, CR and LF included.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * The name the file arrives under in Telegram.
 *
 * Two things are load-bearing:
 *
 * 1. It must end `.html`. Telegram derives a document's `mime_type` from the
 *    filename (grammY hardcodes `application/octet-stream` on the multipart
 *    part itself — see grammy/out/core/payload.js), and the Android client
 *    hands the attachment to Chrome based on that mime type. A board that
 *    arrives extensionless is a board that opens in a file picker.
 *
 * 2. It must contain no space or quote. grammY writes the header as
 *    `filename=${filename}` — UNQUOTED — so the real board basename
 *    "Job Board.html" would be split at the space by a strict parser and lose
 *    its extension, defeating (1). Slugifying is what makes the extension
 *    survive the wire, not cosmetics.
 *
 * `key` is a FALLBACK for a basename that slugifies to nothing, and it is put
 * through the same slugifier rather than trusted. An earlier version's comment
 * claimed no request field reached this function; that was false — the handler
 * passed the raw `board` field — so a padded key produced `"  board  .html"`,
 * reintroducing the very space that (2) exists to remove, and a CRLF key put a
 * header break inside grammY's unquoted `filename=`. Slugifying both arguments
 * makes the claim true by construction instead of by assertion.
 */
export function documentFilename(path: string, key: string): string {
  const stem = slugify(basename(path).replace(/\.html?$/i, ""));
  return `${stem || slugify(key) || "board"}.html`;
}

/** Caption guard. Telegram rejects >1024; we would rather not truncate silently. */
export function assertCaptionFits(caption: string): void {
  if (caption.length > MAX_CAPTION_LEN) {
    throw new DocumentError(
      422,
      `caption is ${caption.length} chars, over Telegram's ${MAX_CAPTION_LEN} limit`,
    );
  }
}

/**
 * Read a configured board off disk, with the size guard applied BEFORE the read.
 *
 * `stat` first is the whole point: a runaway board must fail in milliseconds
 * with a number in the message, not by pulling itself into memory and then
 * timing out somewhere inside an upload.
 *
 * `maxBytes` is a parameter so the over-limit branch can be tested for its
 * BEHAVIOUR rather than by asserting the constant back at itself.
 */
export async function readBoardFile(
  path: string,
  maxBytes: number = MAX_DOCUMENT_BYTES,
): Promise<Buffer> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new DocumentError(404, "board file not found");
  }
  if (!info.isFile()) {
    throw new DocumentError(404, "board path is not a regular file");
  }
  if (info.size === 0) {
    throw new DocumentError(422, "board file is empty");
  }
  if (info.size > maxBytes) {
    throw new DocumentError(
      413,
      `board is ${info.size} bytes, over Telegram's ${maxBytes}-byte document limit`,
    );
  }
  return readFile(path);
}
