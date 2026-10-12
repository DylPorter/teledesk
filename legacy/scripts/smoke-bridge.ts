/**
 * Live smoke test for the tmux bridge. Manual: spends a few cheap haiku turns.
 *
 *   npx tsx legacy/scripts/smoke-bridge.ts
 *
 * Runs entirely on an ISOLATED tmux server (`tmux -L bridgetest`) with a
 * throwaway `claude` in a temp dir. It never lists, reads or types into panes
 * on your default tmux server.
 *
 * Checks: a multi-line message with quotes/backticks is typed in verbatim;
 * the reply is read back from the transcript; a second message queues behind
 * a busy turn; a permission prompt is detected and answered by keystroke; and
 * no fork happened (one transcript, one status file, same pid + session id).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { answerPrompt, capturePane, deliver, type DeliverCallbacks } from "../src/lib/bridge/bridge.js";
import { encodeProjectDir, listLiveSessions, type DiscoveryConfig } from "../src/lib/bridge/discovery.js";
import { parseChunk, isHumanPrompt } from "../src/lib/bridge/transcript.js";
import { classify } from "../src/lib/bridge/router.js";
import { runTmux, stripAnsi } from "../src/lib/bridge/tmux.js";

const SOCKET = "bridgetest";
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const cfg: DiscoveryConfig = { tmux: { bin: process.env.TMUX_BIN || "tmux", socket: SOCKET }, claudeDir };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[smoke]", ...a);

async function screen(pane: string) {
  return stripAnsi(await capturePane(cfg.tmux, pane));
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function collector() {
  const texts: string[] = [];
  const notices: string[] = [];
  const cb: DeliverCallbacks = {
    onText: async (t) => void texts.push(t),
    onNotice: async (n) => void notices.push(n),
    onPrompt: async () => {},
  };
  return { texts, notices, cb };
}

const dir = await mkdtemp(path.join(tmpdir(), "bridge-smoke-"));
log("temp project:", dir);
await runTmux(cfg.tmux, ["new-session", "-d", "-s", "smoke", "-x", "200", "-y", "50", "-c", dir]);

try {
  const pane = (await runTmux(cfg.tmux, ["list-panes", "-a", "-F", "#{pane_id}"])).trim();
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "-l", "claude --model haiku"]);
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "Enter"]);

  // Accept the folder-trust dialog (arrow-driven, not numbered).
  const live = await waitFor("claude to start", async () => {
    const s = await screen(pane);
    if (/trust this folder/i.test(s) && /❯ No, exit/.test(s)) {
      await runTmux(cfg.tmux, ["send-keys", "-t", pane, "Down", "Enter"]);
    }
    const sessions = await listLiveSessions(cfg);
    return sessions.length === 1 && sessions[0].foregroundClaude ? sessions[0] : null;
  });
  log(`live: pane ${live.paneId} pid ${live.pid} session ${live.sessionId} status ${live.status}`);
  await sleep(2000);

  // ── 1. multi-line message, quotes + backticks, reply read back ──────────
  const msg1 = 'Reply with exactly: PONG-7 `a "b" c`\nSecond line of the same message: use no tools.';
  const c1 = collector();
  await deliver(cfg, live.paneId, msg1, c1.cb, { pollMs: 800 });
  log("reply 1:", c1.texts, c1.notices);
  assert.ok(c1.texts.join(" ").includes("PONG-7"), "reply 1 read back");

  const projDir = path.join(claudeDir, "projects", encodeProjectDir(dir));
  const transcript = path.join(projDir, `${live.sessionId}.jsonl`);
  const prompts = parseChunk(await readFile(transcript, "utf8")).records.filter(isHumanPrompt);
  assert.equal(prompts[0].message.content, msg1, "typed verbatim, newline kept, not submitted early");

  // ── 2. two messages at once: the second queues behind the first turn ────
  const a = collector();
  const b = collector();
  const pa = deliver(cfg, live.paneId, "Run the shell command `sleep 5`, then reply with exactly ALPHA-1.", a.cb, { pollMs: 800 });
  await sleep(2500);
  const pb = deliver(cfg, live.paneId, "Reply with exactly BRAVO-2.", b.cb, { pollMs: 800 });
  await Promise.all([pa, pb]);
  log("reply A:", a.texts, "reply B:", b.texts, b.notices);
  assert.ok(a.texts.join(" ").includes("ALPHA-1"));
  assert.ok(b.texts.join(" ").includes("BRAVO-2"));
  assert.ok(!a.texts.join(" ").includes("BRAVO"), "turns kept apart");

  // ── 2b. owner busy at the terminal: the phone message waits its turn ────
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "-l", "Run the shell command `sleep 6`, then reply with exactly OWNER-9."]);
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "Enter"]);
  await waitFor("owner turn to start", async () => (await listLiveSessions(cfg))[0]?.status === "busy", 20_000);
  const q = collector();
  await deliver(cfg, live.paneId, "Reply with exactly CHARLIE-4.", q.cb, { pollMs: 800 });
  log("queued reply:", q.texts, q.notices);
  assert.ok(q.notices.some((n) => n.startsWith("⏳ Queued")), "queued while busy");
  assert.ok(q.texts.join(" ").includes("CHARLIE-4") && !q.texts.join(" ").includes("OWNER-9"));

  // ── 2c. unsent draft in the prompt box: never appended to ──────────────
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "-l", "owner half-typed draft"]);
  const d = collector();
  await deliver(cfg, live.paneId, "should never be typed", d.cb, { pollMs: 500, queueTimeoutMs: 3000 });
  log("draft notices:", d.notices);
  assert.ok(d.notices.some((n) => /unsent text/.test(n) && n.startsWith("⌛")), "refused to type over a draft");
  assert.ok((await screen(pane)).includes("owner half-typed draft") && !(await screen(pane)).includes("should never"));
  await runTmux(cfg.tmux, ["send-keys", "-t", pane, "C-c"]);
  await sleep(1000);

  // ── 3. permission prompt forwarded and answered ─────────────────────────
  // Cycle the permission mode to "manual" so the next tool call asks.
  await waitFor("manual mode", async () => {
    if (/manual mode on/.test(await screen(pane))) return true;
    await runTmux(cfg.tmux, ["send-keys", "-t", pane, "BTab"]);
    await sleep(800);
    return /manual mode on/.test(await screen(pane));
  }, 15_000);
  const c3 = collector();
  let pressed = "";
  c3.cb.onPrompt = async (p, paneId) => {
    log("prompt:", JSON.stringify(p.question), p.options.map((o) => `${o.key}. ${o.label}`));
    pressed = await answerPrompt(cfg, paneId, p.hash, "1");
  };
  await deliver(cfg, live.paneId, "Run the shell command: touch smoke-perm.txt  then reply DONE-3.", c3.cb, { pollMs: 800 });
  log("reply 3:", c3.texts, "pressed:", pressed);
  assert.equal(pressed, "ok");
  assert.ok(existsSync(path.join(dir, "smoke-perm.txt")), "approved command ran");

  // ── 4. router against the isolated session ──────────────────────────────
  const sessions = await listLiveSessions(cfg);
  const decision = await classify(
    { claudeBin: process.env.CLAUDE_BIN || "claude", model: "haiku" },
    sessions,
    "about that PONG / ALPHA / BRAVO test you just did, what came first?",
  );
  log("router:", decision, "summary:", sessions[0].summary);
  assert.ok(decision, "router returned a decision");

  // ── 5. no fork ──────────────────────────────────────────────────────────
  const jsonls = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
  const statusFiles: string[] = [];
  for (const f of await readdir(path.join(claudeDir, "sessions"))) {
    if (!f.endsWith(".json")) continue;
    try {
      if (JSON.parse(await readFile(path.join(claudeDir, "sessions", f), "utf8")).sessionId === live.sessionId) {
        statusFiles.push(f);
      }
    } catch {
      /* raced */
    }
  }
  const after = (await listLiveSessions(cfg))[0];
  log("transcripts in project dir:", jsonls, "status files for session:", statusFiles);
  assert.deepEqual(jsonls, [`${live.sessionId}.jsonl`], "exactly one transcript: no fork");
  assert.deepEqual(statusFiles, [`${live.pid}.json`], "exactly one process owns the session");
  assert.equal(after.pid, live.pid);
  assert.equal(after.sessionId, live.sessionId);
  log("PASS");
} finally {
  await runTmux(cfg.tmux, ["kill-server"]).catch(() => {});
  await sleep(1500);
  await rm(dir, { recursive: true, force: true });
  await rm(path.join(claudeDir, "projects", encodeProjectDir(dir)), { recursive: true, force: true });
}
