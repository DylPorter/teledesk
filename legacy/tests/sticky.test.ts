import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSession } from "../src/lib/bridge/discovery.js";
import { planRoute, resolveSticky, STICKY_MS } from "../src/lib/bridge/sticky.js";

const mk = (n: number, project: string): LiveSession => ({
  n, project, title: null, paneId: `%${n}`, paneTarget: `s:${n}.1`, pid: n, sessionId: "x", cwd: "/", status: "idle",
  transcript: "", summary: { title: null, firstPrompt: null, recentPrompts: [] } as LiveSession["summary"],
  lastActivity: null, foregroundClaude: true,
});
const sessions = [mk(1, "app"), mk(2, "notes")];
const pane2 = { kind: "pane" as const, paneId: "%2", label: "notes" };
const bot = { kind: "bot" as const };
const now = 1_000_000_000;
const long = "can you also check whether the invoice numbering carried over from last month";

test("a short follow-up stays put without asking the router", () => {
  assert.deepEqual(planRoute(pane2, now - 60_000, "yes do it", sessions, now), { go: "stay", target: pane2 });
  assert.deepEqual(planRoute(bot, now - 60_000, "ok", [], now), { go: "stay", target: bot });
});

test("a longer message asks the router but keeps the current target as default", () => {
  assert.deepEqual(planRoute(pane2, now - 60_000, long, sessions, now), { go: "classify", current: pane2 });
});

test("no current, stale, or closed pane falls back to plain routing", () => {
  assert.deepEqual(planRoute(null, null, "yes", sessions, now), { go: "route" });
  assert.deepEqual(planRoute(pane2, now - STICKY_MS - 1, "yes", sessions, now), { go: "route" });
  assert.deepEqual(planRoute({ kind: "pane", paneId: "%9", label: "gone" }, now, "yes", sessions, now), { go: "route" });
});

test("only a confident match for a different session switches", () => {
  assert.deepEqual(resolveSticky(pane2, { target: 1, confidence: 0.84 }, sessions), { go: "stay" });
  assert.deepEqual(resolveSticky(pane2, { target: 2, confidence: 0.99 }, sessions), { go: "stay" });
  assert.deepEqual(resolveSticky(pane2, null, sessions), { go: "stay" });
  assert.deepEqual(resolveSticky(pane2, { target: 1, confidence: 0.9 }, sessions), {
    go: "switch", to: { kind: "pane", paneId: "%1", label: "app" }, label: "app",
  });
});

test("a confident 'new topic' moves a pane conversation to the bot, but not bot to bot", () => {
  assert.deepEqual(resolveSticky(pane2, { target: "new", confidence: 0.9 }, sessions), {
    go: "switch", to: { kind: "bot" }, label: "bot session",
  });
  assert.deepEqual(resolveSticky(bot, { target: "new", confidence: 0.95 }, sessions), { go: "stay" });
});
