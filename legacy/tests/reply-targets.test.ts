import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplyTargets } from "../src/lib/bridge/reply-targets.js";

test("a reply to a bot-session answer resolves to the bot, not a pane", () => {
  const t = new ReplyTargets();
  t.remember(10, { kind: "pane", paneId: "%13", label: "research" });
  t.remember(11, { kind: "bot" });
  assert.deepEqual(t.get(11), { kind: "bot" });
  assert.deepEqual(t.get(10), { kind: "pane", paneId: "%13", label: "research" });
});

test("unknown, missing and null ids resolve to nothing", () => {
  const t = new ReplyTargets();
  t.remember(null, { kind: "bot" });
  assert.equal(t.get(undefined), undefined);
  assert.equal(t.get(99), undefined);
});

test("oldest entry is evicted past the cap, re-remembered ids stay fresh", () => {
  const t = new ReplyTargets(2);
  t.remember(1, { kind: "bot" });
  t.remember(2, { kind: "bot" });
  t.remember(1, { kind: "pane", paneId: "%1", label: "x" }); // 1 is now newest
  t.remember(3, { kind: "bot" }); // evicts 2
  assert.equal(t.get(2), undefined);
  assert.deepEqual(t.get(1), { kind: "pane", paneId: "%1", label: "x" });
  assert.deepEqual(t.get(3), { kind: "bot" });
});
