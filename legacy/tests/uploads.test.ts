import assert from "node:assert/strict";
import { test } from "node:test";
import { Uploads } from "../src/lib/uploads.js";

const C = 1;

test("an album with the caption on the first photo sends every file in one prompt", () => {
  const u = new Uploads();
  u.begin(C, "what do these say?");
  for (let i = 1; i < 9; i++) u.begin(C);
  // Downloads finish out of order; the batch stays open until the last one.
  for (let i = 9; i > 1; i--) assert.equal(u.finish(C, `/a/${i}.jpg`), false);
  assert.equal(u.close(C), null, "cannot close while a download is in flight");
  assert.equal(u.finish(C, "/a/1.jpg"), true);
  const out = u.close(C)!;
  assert.equal(out.paths.length, 9);
  for (let i = 1; i <= 9; i++) assert.match(out.prompt!, new RegExp(`/a/${i}\\.jpg`));
  assert.match(out.prompt!, /these 9 files/);
  assert.match(out.prompt!, /what do these say\?$/);
});

test("uploads without a caption are held and attached to the next text", () => {
  const u = new Uploads();
  u.begin(C);
  u.begin(C);
  u.finish(C, "/a/1.pdf");
  u.finish(C, "/a/2.jpg");
  assert.deepEqual(u.close(C, 1000), { paths: ["/a/1.pdf", "/a/2.jpg"], prompt: null });
  const text = u.withHeld(C, "summarise", 2000);
  assert.match(text, /\/a\/1\.pdf/);
  assert.match(text, /\/a\/2\.jpg/);
  assert.match(text, /summarise$/);
  assert.equal(u.withHeld(C, "next", 3000), "next", "held files are used once");
});

test("held uploads expire, and a failed download doesn't block the batch", () => {
  const u = new Uploads(60_000);
  u.begin(C);
  u.begin(C);
  u.finish(C, null);
  assert.equal(u.finish(C, "/a/ok.jpg"), true);
  assert.deepEqual(u.close(C, 0)!.paths, ["/a/ok.jpg"]);
  assert.equal(u.withHeld(C, "late", 60_001), "late");
});

test("a later captioned upload picks up earlier held files", () => {
  const u = new Uploads();
  u.begin(C);
  u.finish(C, "/a/held.jpg");
  u.close(C, 0);
  u.begin(C, "compare them");
  u.finish(C, "/a/new.jpg");
  const p = u.close(C, 10)!.prompt!;
  assert.match(p, /held\.jpg[\s\S]*new\.jpg/);
  assert.match(p, /these 2 files/);
});
