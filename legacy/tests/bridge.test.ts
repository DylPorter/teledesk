/**
 * Tests for the live-session bridge's pure pieces: session discovery joins,
 * transcript tailing and turn-end detection, pane-state parsing, router output
 * parsing, and the exact tmux argv used to type into a pane.
 *
 * Fixtures under tests/fixtures/bridge mirror real Claude Code 2.1.28x output
 * (status files, transcript records, capture-pane dumps) with paths genericised.
 */

import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  encodeProjectDir,
  findClaudePid,
  matchPanes,
  parsePanes,
  parseProcTable,
  parseSessionFile,
  type SessionFile,
} from "../src/lib/bridge/discovery.js";
import {
  parseChunk,
  readFrom,
  readHeadTail,
  summarize,
  transcriptBusy,
  TurnTracker,
} from "../src/lib/bridge/transcript.js";
import { analyzePane, buildSendArgs, normalizeOutgoing } from "../src/lib/bridge/tmux.js";
import { buildRouterPrompt, parseRouterOutput, routerArgs } from "../src/lib/bridge/router.js";
import type { LiveSession } from "../src/lib/bridge/discovery.js";

const FIX = join(import.meta.dirname, "fixtures", "bridge");
const fx = (name: string) => readFile(join(FIX, name), "utf8");

async function sessionMap(): Promise<Map<number, SessionFile>> {
  const m = new Map<number, SessionFile>();
  for (const pid of [201, 202, 203, 204]) {
    const s = parseSessionFile(await fx(`session-${pid}.json`));
    if (s) m.set(s.pid, s);
  }
  return m;
}

describe("discovery: pid → session mapping", () => {
  test("parses a status file and normalises unknown status", async () => {
    const s = parseSessionFile(await fx("session-201.json"))!;
    assert.equal(s.sessionId, "aaaaaaaa-0000-4000-8000-000000000001");
    assert.equal(s.cwd, "/home/user/projects/app");
    assert.equal(s.status, "idle");
    assert.equal(parseSessionFile(await fx("session-204.json"))!.status, "unknown");
  });

  test("rejects malformed status files", async () => {
    assert.equal(parseSessionFile(await fx("session-bad.json")), null);
    assert.equal(parseSessionFile('{"pid":"1","sessionId":"x","cwd":"/"}'), null);
    assert.equal(parseSessionFile("[]"), null);
  });

  test("encodes a cwd the way Claude Code names project dirs", () => {
    assert.equal(encodeProjectDir("/home/user/notes.vault"), "-home-user-notes-vault");
    assert.equal(encodeProjectDir("/a/b_c/.x"), "-a-b-c--x");
  });

  test("finds claude as a child of the pane shell, or as the pane process itself", async () => {
    const procs = parseProcTable(await fx("ps.txt"));
    const has = (p: number) => [201, 202, 203].includes(p);
    assert.equal(findClaudePid(101, procs, has), 201);
    assert.equal(findClaudePid(202, procs, has), 202);
    assert.equal(findClaudePid(103, procs, has), null);
    // a claude with no status file is not a live session we can map
    assert.equal(findClaudePid(105, procs, has), null);
  });

  test("joins panes to interactive sessions only, sorted by target", async () => {
    const matched = matchPanes(
      parsePanes(await fx("panes.txt")),
      parseProcTable(await fx("ps.txt")),
      await sessionMap(),
    );
    assert.deepEqual(
      matched.map((m) => [m.pane.paneId, m.session.pid]),
      [
        ["%2", 202], // notes:10.1
        ["%1", 201], // work:1.1
      ],
    );
    // %4's claude is kind "bg" → excluded; %3 has no claude; %5 has no status file
  });
});

describe("transcript: tailing and turn-end detection", () => {
  test("tracker ignores history, starts at the human prompt, stops at turn_duration", async () => {
    const t = new TurnTracker();
    const { records } = parseChunk(await fx("transcript-turn.jsonl"));
    const texts = t.feed(records);
    assert.deepEqual(texts, ["Checking the logs first.", "Found it: the session cookie."]);
    assert.equal(t.started, true);
    assert.equal(t.ended, true);
  });

  test("tracker does not start on peer messages or task notifications", async () => {
    const t = new TurnTracker();
    const all = parseChunk(await fx("transcript-before.jsonl")).records;
    // drop the one real human prompt at the top: nothing else may start a turn
    t.feed(all.filter((r) => r.message?.content !== "why does login 500?"));
    assert.equal(t.started, false);
  });

  test("an interrupt ends the turn", async () => {
    const t = new TurnTracker();
    const texts = t.feed(parseChunk(await fx("transcript-interrupted.jsonl")).records);
    assert.deepEqual(texts, ["Starting."]);
    assert.equal(t.ended, true);
  });

  test("tracker works across partial reads", async () => {
    const raw = await fx("transcript-turn.jsonl");
    const t = new TurnTracker();
    const out: string[] = [];
    let buf = "";
    for (let i = 0; i < raw.length; i += 37) {
      buf += raw.slice(i, i + 37);
      const { records, consumed } = parseChunk(buf);
      buf = Buffer.from(buf).subarray(consumed).toString("utf8");
      out.push(...t.feed(records));
      if (t.ended) break;
    }
    assert.deepEqual(out, ["Checking the logs first.", "Found it: the session cookie."]);
  });

  test("readFrom only returns what was appended after the recorded offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, await fx("transcript-before.jsonl"));
    const start = (await readFrom(file, 0)).offset;
    const turn = await fx("transcript-turn.jsonl");
    const cut = turn.indexOf("\n", 200) + 20; // mid-line
    await appendFile(file, turn.slice(0, cut));
    const a = await readFrom(file, start);
    await appendFile(file, turn.slice(cut));
    const b = await readFrom(file, a.offset);
    const t = new TurnTracker();
    const texts = [...t.feed(a.records), ...t.feed(b.records)];
    assert.deepEqual(texts, ["Checking the logs first.", "Found it: the session cookie."]);
    assert.equal(t.ended, true);
  });

  test("transcriptBusy reads the last conversational record", async () => {
    const turn = parseChunk(await fx("transcript-turn.jsonl")).records;
    assert.equal(transcriptBusy(turn.slice(0, 10)), false); // ends at turn_duration
    assert.equal(transcriptBusy(turn.slice(0, 7)), true); // after a tool_result
    assert.equal(transcriptBusy(turn.slice(0, 2)), true); // prompt just sent
    assert.equal(transcriptBusy(turn), false); // last is end_turn
  });

  test("summary prefers the custom title and skips harness messages", async () => {
    const recs = [
      ...parseChunk(await fx("transcript-before.jsonl")).records,
      ...parseChunk(await fx("transcript-turn.jsonl")).records,
    ];
    const s = summarize(recs, 20);
    assert.equal(s.title, "Fix login bug");
    assert.equal(s.firstPrompt, "why does login 500?");
    assert.deepEqual(s.recentPrompts, ["line one line two w…", "next turn"]);
  });

  test("summary falls back to the last-prompt record when no prompt is in the window", () => {
    const s = summarize([
      { type: "user", origin: { kind: "human" }, message: { content: "first ask" } },
      { type: "last-prompt", lastPrompt: "latest ask" },
    ]);
    assert.deepEqual(s.recentPrompts, ["latest ask"]);
  });

  test("readHeadTail on a large file keeps head and tail, drops the middle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    const file = join(dir, "big.jsonl");
    const lines = [JSON.stringify({ type: "user", origin: { kind: "human" }, message: { content: "FIRST" } })];
    for (let i = 0; i < 3000; i++) lines.push(JSON.stringify({ type: "attachment", pad: "x".repeat(200) }));
    lines.push(JSON.stringify({ type: "ai-title", aiTitle: "Tail title" }));
    await writeFile(file, lines.join("\n") + "\n");
    const recs = await readHeadTail(file, 4096, 4096);
    assert.ok(recs.length < 100);
    const s = summarize(recs);
    assert.equal(s.firstPrompt, "FIRST");
    assert.equal(s.title, "Tail title");
  });
});

describe("pane state from capture-pane", () => {
  test("idle with a dim placeholder is idle, no draft", async () => {
    const st = analyzePane(await fx("pane-idle-placeholder.txt"));
    assert.deepEqual(st, { busy: false, prompt: null, draft: null });
  });

  test("an empty prompt box after a 'Waiting for…' line is not busy", async () => {
    assert.deepEqual(analyzePane(await fx("pane-idle-empty.txt")), { busy: false, prompt: null, draft: null });
  });

  test("text in the prompt box is a draft, all lines of it", async () => {
    assert.equal(analyzePane(await fx("pane-draft.txt")).draft, "half-typed thought\n  second line of it");
  });

  test("spinner lines mean busy, current and legacy formats", async () => {
    assert.equal(analyzePane(await fx("pane-busy.txt")).busy, true);
    assert.equal(analyzePane(await fx("pane-busy-legacy.txt")).busy, true);
  });

  test("an ellipsis in ordinary reply text is not a spinner", async () => {
    assert.equal(analyzePane(await fx("pane-false-busy.txt")).busy, false);
  });

  test("permission prompt: question and numbered options, wrapped labels joined", async () => {
    const st = analyzePane(await fx("pane-permission.txt"));
    assert.ok(st.prompt);
    assert.match(st.prompt.question, /^Bash command\ntouch perm-test-file\.txt/);
    assert.match(st.prompt.question, /Do you want to proceed\?$/);
    assert.doesNotMatch(st.prompt.question, /Tip:/);
    assert.deepEqual(
      st.prompt.options.map((o) => o.key),
      ["1", "2", "3", "4"],
    );
    assert.equal(st.prompt.options[0].label, "Yes");
    assert.equal(st.prompt.options[1].label, "Yes, and always allow access to /tmp/proj from this project");
    assert.equal(st.prompt.options[3].label, "No");
    assert.match(st.prompt.hash, /^[0-9a-z]{1,6}$/);
    assert.equal(st.draft, null);
  });

  test("prompt hash is stable for the same prompt and changes for another", async () => {
    const raw = await fx("pane-permission.txt");
    const a = analyzePane(raw).prompt!.hash;
    assert.equal(analyzePane(raw).prompt!.hash, a);
    assert.notEqual(analyzePane(raw.replaceAll("touch perm", "rm -rf perm")).prompt!.hash, a);
  });
});

describe("router output parsing", () => {
  test("plain JSON", () => {
    assert.deepEqual(parseRouterOutput('{"target": 2, "confidence": 0.9}', 3), { target: 2, confidence: 0.9 });
  });

  test("CLI json envelope with fenced JSON inside", () => {
    const env = JSON.stringify({ type: "result", result: 'Sure:\n```json\n{"target":"new","confidence":0.8}\n```' });
    assert.deepEqual(parseRouterOutput(env, 3), { target: "new", confidence: 0.8 });
  });

  test("string numbers are coerced, confidence clamped", () => {
    assert.deepEqual(parseRouterOutput('{"target":"3","confidence":"1.7"}', 3), { target: 3, confidence: 1 });
    assert.deepEqual(parseRouterOutput('{"target":1,"confidence":-2}', 3), { target: 1, confidence: 0 });
    assert.deepEqual(parseRouterOutput('{"target":1}', 3), { target: 1, confidence: 0 });
  });

  test("malformed or out-of-range output is null", () => {
    for (const bad of [
      "",
      "I think session two",
      '{"target": 4, "confidence": 0.9}',
      '{"target": 0.5, "confidence": 0.9}',
      '{"target": "banana", "confidence": 0.9}',
      '{"target": 2, "confidence": 0.9',
      JSON.stringify({ type: "result", result: "no json here" }),
    ]) {
      assert.equal(parseRouterOutput(bad, 3), null, bad);
    }
  });

  test("skips an invalid brace group and takes the next valid one", () => {
    assert.deepEqual(
      parseRouterOutput('e.g. {"target": 9} → actual: {"target": 1, "confidence": 0.75}', 3),
      { target: 1, confidence: 0.75 },
    );
  });

  test("router runs tool-less and without persisting a session", () => {
    const a = routerArgs("P", "haiku");
    assert.deepEqual(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2), ["--tools", ""]);
    assert.ok(a.includes("--no-session-persistence"));
    assert.ok(!a.includes("bypassPermissions"));
    assert.ok(!a.includes("--resume"));
  });

  test("prompt lists every session with its number and the previous target", () => {
    const mk = (n: number, project: string, title: string): LiveSession => ({
      n, project, title, paneId: `%${n}`, paneTarget: `s:${n}.1`, pid: n, sessionId: "x", cwd: "/", status: "idle",
      transcript: "", summary: { title, firstPrompt: `first ${n}`, recentPrompts: [`recent ${n}`] },
      lastActivity: null, foregroundClaude: true,
    });
    const p = buildRouterPrompt([mk(1, "app", "Login"), mk(2, "notes", "Tarot")], "hello", 2);
    assert.match(p, /1\. \[app\] "Login"\n {3}started with: first 1\n {3}recently: recent 1/);
    assert.match(p, /previous phone message went to session 2/);
    assert.match(p, /"""\nhello\n"""/);
  });
});

describe("literal send-keys arguments", () => {
  test("quotes, backticks and $ pass through untouched, after --", () => {
    const text = `run \`ls\` and "echo $HOME" 'now'`;
    const { type, submit } = buildSendArgs("%3", text);
    assert.deepEqual(type, ["send-keys", "-t", "%3", "-l", "--", text]);
    assert.deepEqual(submit, ["send-keys", "-t", "%3", "Enter"]);
  });

  test("a message starting with - is data, not a flag", () => {
    assert.deepEqual(buildSendArgs("%1", "-n oops").type.slice(-2), ["--", "-n oops"]);
  });

  test("newlines survive as LF; CRLF/CR are normalised so nothing submits early", () => {
    assert.equal(buildSendArgs("%1", "a\r\nb\rc\nd").type.at(-1), "a\nb\nc\nd");
  });

  test("control characters and escape sequences are stripped, tabs become spaces", () => {
    assert.equal(normalizeOutgoing("x\u001b[31my\u0003z\tw\u0007"), "x[31myz  w");
  });

  test("trailing whitespace is trimmed and empty messages are refused", () => {
    assert.equal(normalizeOutgoing("hi \n\n"), "hi");
    assert.throws(() => buildSendArgs("%1", " \n\t"));
  });
});
