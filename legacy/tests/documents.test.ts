/**
 * Tests for the /push-document allowlist, filename and guards.
 *
 * Pure logic + a tmpdir. No sockets: nothing here starts a server or reaches
 * the Telegram API.
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe } from "node:test";

import {
  DocumentError,
  DocumentConfigError,
  loadDocumentRegistry,
  MAX_CAPTION_LEN,
  MAX_DOCUMENT_BYTES,
  assertCaptionFits,
  documentFilename,
  parseDocumentRegistry,
  readBoardFile,
  resolveBoardPath,
} from "../src/lib/documents.js";

/** `assert.throws` returns undefined, so capture the error ourselves. */
function caught(fn: () => unknown): DocumentError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DocumentError, `expected a DocumentError, got ${err}`);
    return err;
  }
  assert.fail("expected a DocumentError, nothing was thrown");
}

async function caughtAsync(p: Promise<unknown>): Promise<DocumentError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof DocumentError, `expected a DocumentError, got ${err}`);
    return err;
  }
  assert.fail("expected a DocumentError, nothing was thrown");
}

describe("parseDocumentRegistry", () => {
  test("unset means an empty registry — the feature is off by default", () => {
    assert.equal(parseDocumentRegistry(undefined).size, 0);
    assert.equal(parseDocumentRegistry("").size, 0);
    assert.equal(parseDocumentRegistry("   ").size, 0);
  });

  test("parses key=path pairs", () => {
    const reg = parseDocumentRegistry("job-board=/srv/boards/a.html, events_board=/srv/b.html");
    assert.deepEqual([...reg.entries()], [
      ["job-board", "/srv/boards/a.html"],
      ["events_board", "/srv/b.html"],
    ]);
  });

  test("keeps a path containing '=' intact (splits on the FIRST '=')", () => {
    const reg = parseDocumentRegistry("k=/srv/a=b/board.html");
    assert.equal(reg.get("k"), "/srv/a=b/board.html");
  });

  test("rejects a relative path", () => {
    assert.throws(() => parseDocumentRegistry("k=boards/a.html"), DocumentConfigError);
  });

  test("rejects a traversal-shaped relative path", () => {
    assert.throws(() => parseDocumentRegistry("k=../../etc/passwd"), DocumentConfigError);
  });

  test("rejects a malformed entry rather than skipping it", () => {
    assert.throws(() => parseDocumentRegistry("/srv/a.html"), DocumentConfigError);
    assert.throws(() => parseDocumentRegistry("=/srv/a.html"), DocumentConfigError);
  });

  test("rejects a key with path characters in it", () => {
    assert.throws(() => parseDocumentRegistry("../k=/srv/a.html"), DocumentConfigError);
    assert.throws(() => parseDocumentRegistry("A B=/srv/a.html"), DocumentConfigError);
  });

  test("rejects a duplicated key", () => {
    assert.throws(() => parseDocumentRegistry("k=/srv/a.html,k=/srv/b.html"), DocumentConfigError);
  });

  test("rejects a NUL byte in a path", () => {
    assert.throws(() => parseDocumentRegistry("k=/srv/a\0.html"), DocumentConfigError);
  });
});

describe("resolveBoardPath", () => {
  const reg = parseDocumentRegistry("job-board=/srv/boards/job.html");

  test("returns the CONFIGURED path for a known key", () => {
    assert.equal(resolveBoardPath(reg, "job-board"), "/srv/boards/job.html");
  });

  test("an empty registry refuses with 503, not a lookup", () => {
    assert.equal(caught(() => resolveBoardPath(new Map(), "job-board")).status, 503);
  });

  test("an unknown key is a 400 — no fallthrough to the filesystem", () => {
    assert.equal(caught(() => resolveBoardPath(reg, "nope")).status, 400);
  });

  test("a caller-supplied PATH is not a key and is refused", () => {
    for (const attempt of [
      "/etc/passwd",
      "../../etc/passwd",
      "/srv/boards/job.html",
      "job-board/../../../etc/passwd",
    ]) {
      assert.equal(caught(() => resolveBoardPath(reg, attempt)).status, 400, `${attempt} should be refused`);
    }
  });

  test("a non-string board is refused", () => {
    for (const attempt of [undefined, null, 42, {}, ["job-board"]]) {
      assert.throws(() => resolveBoardPath(reg, attempt), DocumentError);
    }
  });

  test("the error names the configured KEYS but never the paths", () => {
    const err = caught(() => resolveBoardPath(reg, "nope"));
    assert.match(err.message, /job-board/);
    assert.doesNotMatch(err.message, /\/srv/);
  });
});

describe("documentFilename", () => {
  test("always ends .html so Telegram reports a text/html mime type", () => {
    assert.equal(documentFilename("/srv/boards/board", "k"), "board.html");
    assert.equal(documentFilename("/srv/boards/board.html", "k"), "board.html");
    assert.equal(documentFilename("/srv/boards/board.HTML", "k"), "board.html");
    assert.equal(documentFilename("/srv/boards/board.htm", "k"), "board.html");
  });

  test("a space in the basename is slugified away", () => {
    // grammY writes `filename=${name}` UNQUOTED, so a space would truncate the
    // name on the wire and cost it the .html extension.
    assert.equal(documentFilename("/srv/Areas/Work/Job Board.html", "k"), "job-board.html");
  });

  test("no whitespace or quoting characters survive", () => {
    const name = documentFilename('/srv/a b"c\'d;e.html', "k");
    assert.doesNotMatch(name, /[\s"';\\]/);
    assert.match(name, /\.html$/);
  });

  test("falls back to the key when the basename slugifies to nothing", () => {
    assert.equal(documentFilename("/srv/boards/###.html", "job-board"), "job-board.html");
  });

  test("carries no directory component", () => {
    assert.doesNotMatch(documentFilename("/srv/deep/nested/board.html", "k"), /\//);
  });
});

describe("assertCaptionFits", () => {
  test("accepts a caption at the limit", () => {
    assertCaptionFits("x".repeat(MAX_CAPTION_LEN));
  });

  test("rejects one over it with 422 rather than truncating", () => {
    assert.equal(caught(() => assertCaptionFits("x".repeat(MAX_CAPTION_LEN + 1))).status, 422);
  });
});

describe("readBoardFile", () => {
  test("reads a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const path = join(dir, "board.html");
    await writeFile(path, "<html>board</html>");
    const buf = await readBoardFile(path);
    assert.equal(buf.toString(), "<html>board</html>");
  });

  test("a missing file is 404, not a hang", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    assert.equal((await caughtAsync(readBoardFile(join(dir, "gone.html")))).status, 404);
  });

  test("a directory is 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const sub = join(dir, "sub");
    await mkdir(sub);
    assert.equal((await caughtAsync(readBoardFile(sub))).status, 404);
  });

  test("an empty file is refused — a zero-byte board is not a board", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const path = join(dir, "board.html");
    await writeFile(path, "");
    assert.equal((await caughtAsync(readBoardFile(path))).status, 422);
  });

  test("a file over the limit is refused with 413, and is NOT read", async () => {
    // Behaviour, not the constant restated back at itself: the limit is
    // injected so the over-size BRANCH can run without writing 50 MB.
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const path = join(dir, "board.html");
    await writeFile(path, "x".repeat(1024));
    const err = await caughtAsync(readBoardFile(path, 512));
    assert.equal(err.status, 413);
    assert.match(err.message, /1024 bytes/);
  });

  test("a file exactly at the limit is allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const path = join(dir, "board.html");
    await writeFile(path, "x".repeat(512));
    assert.equal((await readBoardFile(path, 512)).byteLength, 512);
  });

  test("the default limit is Telegram's document ceiling", () => {
    assert.equal(MAX_DOCUMENT_BYTES, 50 * 1024 * 1024);
  });

  test("the guard fires before the read — the file is never opened", async () => {
    // Structural, not timed: an earlier version asserted a wall-clock ceiling,
    // which is a flake waiting for a loaded machine. A sparse 51 MB file is
    // refused by SIZE; a `stat` sees that instantly, while a read would have to
    // pull 51 MB. Chmod 000 removes the ambiguity entirely — if the guard did
    // not run first, the open would fail with EACCES (a 404 from the catch)
    // rather than the 413 the size branch produces.
    const dir = await mkdtemp(join(tmpdir(), "push-doc-"));
    const path = join(dir, "board.html");
    const handle = await open(path, "w");
    await handle.truncate(51 * 1024 * 1024);
    await handle.close();
    await chmod(path, 0o000);
    const err = await caughtAsync(readBoardFile(path));
    assert.equal(err.status, 413, "an unreadable file was opened before its size was checked");
  });
});

describe("loadDocumentRegistry", () => {
  test("a good allowlist parses with no problem", () => {
    const { registry, problem } = loadDocumentRegistry("k=/srv/a.html");
    assert.equal(registry.get("k"), "/srv/a.html");
    assert.equal(problem, null);
  });

  test("unset is not a problem — it is the default-off state", () => {
    const { registry, problem } = loadDocumentRegistry(undefined);
    assert.equal(registry.size, 0);
    assert.equal(problem, null);
  });

  test("a malformed allowlist DEGRADES rather than throwing", () => {
    // The throw would land before bot.start() in a unit that restarts on
    // failure with no StartLimit override — one typo in an optional feature
    // would take the whole bot down and keep it down.
    const { registry, problem } = loadDocumentRegistry("k=relative/path.html");
    assert.equal(registry.size, 0);
    assert.ok(problem);
  });

  test("the reason survives into the 503 the endpoint answers with", () => {
    const { registry, problem } = loadDocumentRegistry("k=relative/path.html");
    const err = caught(() => resolveBoardPath(registry, "k", problem));
    assert.equal(err.status, 503);
    assert.match(err.message, /document delivery disabled/);
  });

  test("an unset registry still says 'not configured', not 'disabled'", () => {
    const { registry, problem } = loadDocumentRegistry("");
    assert.match(caught(() => resolveBoardPath(registry, "k", problem)).message, /not configured/);
  });

  test("a config problem never echoes the offending path back", () => {
    // It reaches the journal AND, via the 503, the operator's digest bubble.
    const { problem } = loadDocumentRegistry("k=srv/private/vault/Job Board.html");
    assert.ok(problem);
    assert.doesNotMatch(problem, /vault|Job Board/);
    assert.match(problem, /entry #1/);
  });
});

describe("documentFilename fallback key", () => {
  test("an untrimmed fallback key cannot reintroduce a space", () => {
    assert.equal(documentFilename("/srv/###.html", "  job-board  "), "job-board.html");
  });

  test("a CRLF fallback key cannot break the unquoted filename header", () => {
    const name = documentFilename("/srv/###.html", "a\r\nb");
    assert.doesNotMatch(name, /[\r\n]/);
    assert.match(name, /\.html$/);
  });

  test("a fallback key that slugifies to nothing still yields a valid name", () => {
    assert.equal(documentFilename("/srv/###.html", "!!!"), "board.html");
  });
});
