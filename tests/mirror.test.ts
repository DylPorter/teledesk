/** Tests for the mirror protocol line: the token-gated hook message, the launcher
 * that mints the token into the session's child env, the channel hello that carries it,
 * and the mirror-hook CLI that classifies hook JSON and transports the lines. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChannelMessage, DaemonMessage, decode, encode, LineReader, MAX_TEXT_BYTES, MIRROR_TOKEN, type MirrorMessage } from "../src/desk/protocol.js";
import {
  extractHistory, extractTurnAssistant, MIRROR_TIMEOUT_MS, mirrorLinesFor, runMirrorHook,
  stripChannelWrapper, toolEndSummary, toolStartSummary, type HookInput,
} from "../src/desk/mirror-hook.js";
import { runClaude } from "../src/desk/launcher.js";
import { startDeskChannel } from "../src/desk/channel.js";
import { HOOK_MARKER, hookEntries, install, mergeHookSettings, removeHookSettings, uninstall } from "../src/desk/install.js";
import { DeskRouter, REPLY_MARK, TOOL_ICONS, type DeskLimits } from "../src/desk/router.js";
import { SqliteDeskState } from "../src/desk/state.js";
import { REPO_ROOT } from "../src/paths.js";
import { FakeTelegram, G, GROUP, OWNER, tmp, until } from "./helpers.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const CC = "3f9a1c2b-0d4e-4a7b-8c5d-1e2f3a4b5c6d";

const mirror = (line: MirrorMessage["line"]): MirrorMessage => ({ type: "mirror", token: TOKEN, cc_session: CC, line });
const bad = (m: unknown) => decode(ChannelMessage, JSON.stringify(m));

const LINES: MirrorMessage["line"][] = [
  { kind: "user_prompt", text: "hello" },
  { kind: "assistant", text: "here is my answer" },
  { kind: "tool_start", tool_name: "Bash", summary: "ls -la" },
  { kind: "tool_end", tool_name: "Bash", ok: true, summary: "exit 0" },
  { kind: "turn_end" },
  { kind: "history", text: "an earlier message" },
];

describe("mirror protocol", () => {
  it("a valid line of every kind decodes", () => {
    for (const line of LINES) {
      const m = mirror(line);
      expect(decode(ChannelMessage, encode(m))).toEqual(m);
    }
  });

  it("a bad token, an unknown kind, and an empty text are rejected", () => {
    expect(bad({ type: "mirror", cc_session: CC, token: "xyz", line: { kind: "user_prompt", text: "hi" } })).toBeUndefined();
    expect(bad({ type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "nope", text: "hi" } })).toBeUndefined();
    expect(bad({ type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "user_prompt", text: "  " } })).toBeUndefined();
  });

  it("an overlong summary is rejected", () => {
    expect(bad({ type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "tool_start", tool_name: "Bash", summary: "x".repeat(3000) } })).toBeUndefined();
  });

  it("hello accepts an optional mirror_token", () => {
    const hello = (extra: object = {}) => JSON.stringify({ type: "hello", cwd: "/w/proj", pid: 12, title: "proj", ...extra });
    expect(decode(ChannelMessage, hello())).toBeDefined();
    expect(decode(ChannelMessage, hello({ mirror_token: TOKEN }))).toBeDefined();
    expect(decode(ChannelMessage, hello({ mirror_token: TOKEN.toUpperCase() }))).toBeUndefined();
  });

  it("extra fields are rejected", () => {
    for (const line of LINES) {
      expect(bad({ type: "mirror", token: TOKEN, cc_session: CC, line: { ...line, extra: 1 } })).toBeUndefined();
    }
    expect(bad({ type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "turn_end" }, extra: 1 })).toBeUndefined();
  });
});

describe("launcher token", () => {
  /** Run runClaude with node as the "claude": the child writes the mirror token it received. */
  const childSaw = async (desk: boolean, env: NodeJS.ProcessEnv): Promise<string> => {
    const marker = join(tmp(), "token");
    const probe = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.TELEDESK_MIRROR ?? "")`];
    expect(await runClaude({ args: probe, desk, claude: process.execPath, env })).toBe(0);
    return readFileSync(marker, "utf8");
  };

  it("desk:true gives the child a fresh 32-hex token", async () => {
    expect(await childSaw(true, {})).toMatch(MIRROR_TOKEN);
  });

  it("two launches mint different tokens", async () => {
    const a = await childSaw(true, {});
    const b = await childSaw(true, {});
    expect(a).toMatch(MIRROR_TOKEN);
    expect(b).toMatch(MIRROR_TOKEN);
    expect(a).not.toBe(b);
  });

  it("desk:false strips the token even when the parent has one", async () => {
    expect(await childSaw(false, { TELEDESK_MIRROR: TOKEN })).toBe("");
  });
});

describe("channel hello token", () => {
  /** Run the real `teledesk desk-channel` child against a fake daemon socket, open its desk
   * over the stdio MCP (the link is dormant until desk_on, and hello goes out on connect),
   * and return the first line it sent — raw JSON, so an invalid token is visible too.
   * Closes stdin at the end: the channel says bye and exits. */
  const channelHello = async (mirrorToken: string): Promise<Record<string, unknown>> => {
    const dir = tmp();
    const socketPath = join(dir, "desk.sock");
    const hellos: Record<string, unknown>[] = [];
    const socks: Socket[] = [];
    const server = createServer((sock) => {
      socks.push(sock);
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m: unknown;
          try { m = JSON.parse(line); } catch { continue; }
          const msg = m as Record<string, unknown>;
          if (msg.type === "hello") {
            hellos.push(msg);
            sock.write(JSON.stringify({ type: "welcome", session_id: 1, topic_name: "proj" }) + "\n");
          }
        }
      });
      sock.on("error", () => { /* the client closing is normal */ });
    });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
    const child = spawn(join(REPO_ROOT, "bin", "teledesk"), ["desk-channel"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TELEDESK: "1", TELEDESK_DATA_DIR: dir, TELEDESK_MIRROR: mirrorToken, CLAUDE_PROJECT_DIR: dir },
    });
    child.stderr!.resume(); // channel logs; never written to (the token must not appear there)
    let outBuf = "";
    child.stdout!.on("data", (d: Buffer) => { outBuf += d.toString("utf8"); });
    const initDone = new Promise<void>((resolve, reject) => {
      const check = () => { if (outBuf.includes('"id":1')) resolve(); };
      child.stdout!.on("data", check);
      child.once("exit", (code) => reject(new Error(`desk-channel exited early (code ${code}) before answering initialize; stderr/stdout: ${outBuf}`)));
    });
    child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mirror-test", version: "1" } },
    }) + "\n");
    await initDone;
    for (const m of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desk_on", arguments: {} } },
    ]) child.stdin!.write(JSON.stringify(m) + "\n");
    await until(() => hellos.length > 0, 15_000);
    await new Promise<void>((r) => {
      const t = setTimeout(() => { child.kill(); r(); }, 3000);
      child.once("exit", () => { clearTimeout(t); r(); });
      child.stdin!.end();
    });
    for (const x of socks) x.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    return hellos[0];
  };

  it("hello carries a valid mirror token and ignores an invalid one", async () => {
    const good = await channelHello(TOKEN);
    expect(good.type).toBe("hello");
    expect(good.mirror_token).toBe(TOKEN);
    const bad = await channelHello("not-a-token");
    expect(bad.type).toBe("hello");
    expect("mirror_token" in bad).toBe(false);
  }, 60_000);
});

describe("mirror-hook transport", () => {
  /** A fake daemon: a unix socket that counts connections and collects the decoded mirror lines. */
  const fakeDaemon = async () => {
    const socketPath = join(tmp(), "desk.sock");
    const msgs: MirrorMessage[] = [];
    const socks: Socket[] = [];
    let conns = 0;
    const server = createServer((sock) => {
      conns++;
      socks.push(sock);
      const reader = new LineReader((line) => {
        const m = decode(ChannelMessage, line);
        if (m && m.type === "mirror") msgs.push(m);
      });
      sock.on("data", (d) => { reader.push(d); });
      sock.on("error", () => { /* the client closing is normal */ });
    });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
    return {
      socketPath, msgs, connections: () => conns,
      close: async () => { for (const s of socks) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
    };
  };

  const hookEnv = () => ({ TELEDESK_MIRROR: TOKEN });
  const hookJson = (h: Record<string, unknown>) => JSON.stringify({ session_id: CC, ...h });

  it("no token, no send", async () => {
    const d = await fakeDaemon();
    const code = await runMirrorHook(hookJson({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), {}, d.socketPath);
    expect(code).toBe(0);
    expect(d.connections()).toBe(0);
    expect(d.msgs).toEqual([]);
    await d.close();
  });

  it("malformed stdin exits 0", async () => {
    const d = await fakeDaemon();
    expect(await runMirrorHook("{", hookEnv(), d.socketPath)).toBe(0);
    expect(d.connections()).toBe(0);
    expect(d.msgs).toEqual([]);
    await d.close();
  });

  it("unknown event exits 0 without connecting", async () => {
    const d = await fakeDaemon();
    expect(await runMirrorHook(hookJson({ hook_event_name: "SessionStart" }), hookEnv(), d.socketPath)).toBe(0);
    expect(d.connections()).toBe(0);
    expect(d.msgs).toEqual([]);
    await d.close();
  });

  it("a prompt becomes one mirror line", async () => {
    const d = await fakeDaemon();
    expect(await runMirrorHook(hookJson({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" }), hookEnv(), d.socketPath)).toBe(0);
    await until(() => d.msgs.length === 1);
    expect(d.msgs[0]).toEqual({ type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "user_prompt", text: "fix the bug" } });
    await d.close();
  });

  it("Stop sends assistant-then-turn_end when the transcript has text", async () => {
    const d = await fakeDaemon();
    const code = await runMirrorHook(
      hookJson({ hook_event_name: "Stop", transcript_path: join(tmp(), "absent.jsonl") }),
      hookEnv(), d.socketPath, { extractTurnAssistant: () => "the answer" },
    );
    expect(code).toBe(0);
    await until(() => d.msgs.length === 2);
    expect(d.msgs).toEqual([
      { type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "assistant", text: "the answer" } },
      { type: "mirror", token: TOKEN, cc_session: CC, line: { kind: "turn_end" } },
    ]);
    await d.close();
  });

  it("a dead socket still exits 0", async () => {
    const dead = join(tmp(), "no-daemon.sock");
    const t0 = Date.now();
    const code = await runMirrorHook(hookJson({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), hookEnv(), dead);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(MIRROR_TIMEOUT_MS + 200);
  });
});

describe("mirror-hook classification", () => {
  const env = { TELEDESK_MIRROR: TOKEN };
  const kinds = (lines: MirrorMessage[]) => lines.map((m) => m.line.kind);

  it("needs the token and a session id", () => {
    const h: HookInput = { hook_event_name: "UserPromptSubmit", session_id: CC, prompt: "hi" };
    expect(mirrorLinesFor(h, {})).toEqual([]);
    expect(mirrorLinesFor(h, { TELEDESK_MIRROR: "not-a-token" })).toEqual([]);
    expect(mirrorLinesFor({ hook_event_name: "UserPromptSubmit", prompt: "hi" }, env)).toEqual([]);
    expect(mirrorLinesFor({ hook_event_name: "UserPromptSubmit", session_id: "", prompt: "hi" }, env)).toEqual([]);
  });

  it("an empty prompt is nothing to send", () => {
    expect(mirrorLinesFor({ hook_event_name: "UserPromptSubmit", session_id: CC, prompt: "   " }, env)).toEqual([]);
  });

  it("a pasted multibyte prompt over the byte bound is clipped on the way out", () => {
    // Same class as the answer clip: the CLI clips before sending, the daemon's decode re-checks —
    // an unclipped 90KB prompt dies at the validator and the turn's input never reaches the topic.
    const l = mirrorLinesFor({ hook_event_name: "UserPromptSubmit", session_id: CC, prompt: "漢".repeat(30_000) }, env);
    expect(l).toHaveLength(1);
    if (l[0]!.line.kind !== "user_prompt") throw new Error("expected a user_prompt line");
    expect(Buffer.byteLength(l[0]!.line.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(decode(ChannelMessage, encode(l[0]!))).toBeDefined();
  });

  it("a tool call becomes start and end lines", () => {
    const pre = mirrorLinesFor({ hook_event_name: "PreToolUse", session_id: CC, tool_name: "Bash", tool_input: { command: "echo one" } }, env);
    expect(pre[0]).toMatchObject({ type: "mirror", token: TOKEN, cc_session: CC });
    expect(pre[0]!.line).toMatchObject({ kind: "tool_start", tool_name: "Bash" });
    expect(pre[0]!.line.kind === "tool_start" && pre[0]!.line.summary).toContain("echo one");
    const post = mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "Bash", tool_response: { stdout: "one", stderr: "", interrupted: false } }, env);
    expect(post[0]!.line).toMatchObject({ kind: "tool_end", tool_name: "Bash", ok: true });
  });

  it("a missing or error-shaped response is not ok", () => {
    const noResp = mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "Bash" }, env);
    expect(noResp[0]!.line).toMatchObject({ kind: "tool_end", ok: false });
    const err = mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "Bash", tool_response: { error: "boom" } }, env);
    expect(err[0]!.line).toMatchObject({ kind: "tool_end", ok: false });
  });

  it("internal gating tools never become bubbles", () => {
    expect(mirrorLinesFor({ hook_event_name: "PreToolUse", session_id: CC, tool_name: "ToolSearch", tool_input: { query: "select:mcp__x__y" } }, env)).toEqual([]);
    expect(mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "ToolSearch", tool_response: { matches: [], query: "x", total_deferred_tools: 1 } }, env)).toEqual([]);
  });

  it("the subagent tool fires as Agent", () => {
    const l = mirrorLinesFor({ hook_event_name: "PreToolUse", session_id: CC, tool_name: "Agent", tool_input: { description: "run echo" } }, env);
    expect(l[0]!.line).toMatchObject({ kind: "tool_start", tool_name: "Agent" });
  });

  it("desk_on with no transcript path has no history to send", () => {
    // The trigger reads the transcript only through transcript_path; with none there is no
    // history line — and desk_on never becomes a tool_end bubble either.
    const l = mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "mcp__teledesk__desk_on", tool_response: [{ type: "text", text: "Desk is on" }] }, env);
    expect(l).toEqual([]);
  });

  it("Stop with an unreadable transcript sends turn_end only", () => {
    const l = mirrorLinesFor({ hook_event_name: "Stop", session_id: CC, transcript_path: join(tmp(), "absent.jsonl") }, env);
    expect(kinds(l)).toEqual(["turn_end"]);
  });

  it("stripChannelWrapper unwraps a phone message and leaves others alone", () => {
    expect(stripChannelWrapper('<channel source="teledesk" message_id="42">ping</channel>')).toBe("ping");
    expect(stripChannelWrapper('<channel source="teledesk" message_id="42">\nlong text\n</channel>')).toBe("long text");
    const plain = "terminal-typed prompt";
    expect(stripChannelWrapper(plain)).toBe(plain);
  });
});

describe("transcript extraction", () => {
  /** JSONL fixture rows built as { type, message: { role, content } }; a raw string row is
   * passed through verbatim so fixtures can carry a malformed line. */
  const jsonl = (...rows: ({ type: string; content: unknown } | string)[]) =>
    rows.map((r) => (typeof r === "string" ? r : JSON.stringify({ type: r.type, message: { role: r.type, content: r.content } }))).join("\n");
  const asked = (text: string) => ({ type: "user", content: text });
  const said = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] });
  const toolResult = (text: string) => ({ type: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: text }] });

  it("collects assistant text after the last string-content user row", () => {
    const fx = jsonl(
      asked("an earlier turn"), said("the earlier answer"),
      asked("run echo and tell me what it printed"),
      said("I'll run it now."), toolResult("one"), said("It printed one."),
    );
    // Both assistant messages of the turn; the tool_result user row does not bound it.
    expect(extractTurnAssistant(fx)).toBe("I'll run it now.\n\nIt printed one.");
  });

  it("extractTurnAssistant returns undefined for a tool-only turn", () => {
    const fx = jsonl(
      asked("run it"),
      { type: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo one" } }] },
      toolResult("one"),
    );
    expect(extractTurnAssistant(fx)).toBeUndefined();
  });

  it("extractTurnAssistant output is clipped to MAX_TEXT_BYTES", () => {
    const fx = jsonl(asked("say it big"), said("x".repeat(70 * 1024)));
    const out = extractTurnAssistant(fx);
    expect(out).toBeDefined();
    expect(Buffer.byteLength(out!, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("extractTurnAssistant clips a dense multibyte answer by UTF-8 bytes, not units", () => {
    // 漢 is one UTF-16 unit but three UTF-8 bytes: 30k units is 90k bytes, over the daemon's bound
    // while still under its 64k-unit length — so a clip that counts units ships the whole answer and
    // the strict decode discards it (no bubble, no notice). The clip has to count bytes.
    const fx = jsonl(asked("多說一點"), said("漢".repeat(30_000)));
    const out = extractTurnAssistant(fx);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(MAX_TEXT_BYTES); // units, which is never the binding cap
    expect(Buffer.byteLength(out!, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(decode(ChannelMessage, encode(mirror({ kind: "assistant", text: out! })))).toBeDefined();
  });

  it("malformed lines are skipped", () => {
    const fx = jsonl(asked("hi"), "not json", '{"unclosed": ', said("there"));
    expect(extractTurnAssistant(fx)).toBe("there");
    expect(extractHistory(jsonl(asked("one"), "not json", said("a1"), asked("two"), "{oops", said("a2"))))
      .toBe("🧑 one\n\n🤖 a1\n\n---\n\n🧑 two\n\n🤖 a2");
  });

  it("an empty or all-malformed transcript yields nothing", () => {
    expect(extractTurnAssistant("")).toBeUndefined();
    expect(extractTurnAssistant("}\nnot json at all\n")).toBeUndefined();
    expect(extractHistory("")).toBeUndefined();
  });

  it("content blocks without text are ignored", () => {
    const fx = jsonl(asked("hi"), {
      type: "assistant",
      content: [null, "a bare string", { type: "tool_use", id: "toolu_01" }, { text: "A" }, { text: "" }, { text: "B" }],
    });
    expect(extractTurnAssistant(fx)).toBe("A\n\nB");
  });

  it("extractHistory returns up to five marked pairs, oldest first", () => {
    const rows: { type: string; content: unknown }[] = [];
    for (let i = 1; i <= 7; i++) {
      rows.push(asked(`p${i} ${"q".repeat(600)}`), said(`a${i} ${"w".repeat(600)}`));
    }
    const out = extractHistory(jsonl(...rows));
    expect(out).toBeDefined();
    const s = out!;
    // the five newest turns, rendered oldest first, with marks and separators
    expect(s.split("\n\n---\n\n")).toHaveLength(5);
    expect(s.match(/🧑/g)).toHaveLength(5);
    expect(s.match(/🤖/g)).toHaveLength(5);
    expect(s).not.toContain("p1");
    expect(s).not.toContain("p2");
    for (const t of ["p3", "p4", "p5", "p6", "p7"]) expect(s).toContain(t);
    expect(s.indexOf("p3")).toBeLessThan(s.indexOf("p7"));
    // each side clipped at 500 chars: 3-char tag + 496 filler + the ellipsis marker
    expect(s).toContain("p3 " + "q".repeat(496) + "…");
    expect(s).toContain("a7 " + "w".repeat(496) + "…");
    expect(s).not.toContain("q".repeat(500));
    expect(extractHistory("")).toBeUndefined();
  });

  it("a prompt with no answer is not a completed pair", () => {
    const fx = jsonl(asked("first"), said("answer one"), asked("second, still running"));
    expect(extractHistory(fx)).toBe("🧑 first\n\n🤖 answer one");
  });

  it("extractHistory total is clipped to MAX_TEXT_BYTES", () => {
    const rows: { type: string; content: unknown }[] = [];
    for (let i = 0; i < 5; i++) rows.push(asked("w".repeat(20_000)), said("v".repeat(20_000)));
    const out = extractHistory(jsonl(...rows))!;
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("extractHistory's total clip is a byte cap on multibyte text too", () => {
    // perTurnChars widened so the total clip is what binds: ~60k units of 3-byte text ≈ 180k bytes.
    const rows: { type: string; content: unknown }[] = [];
    for (let i = 0; i < 5; i++) rows.push(asked("漢".repeat(6_000)), said("漢".repeat(6_000)));
    const out = extractHistory(jsonl(...rows), 5, 6_000)!;
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(decode(ChannelMessage, encode(mirror({ kind: "history", text: out })))).toBeDefined();
  });

  it("summaries special-case Bash, Read, Task and fall back to JSON", () => {
    expect(toolStartSummary("Bash", { command: "echo one", description: "Print one" })).toBe("echo one");
    expect(toolStartSummary("Read", { file_path: "/tmp/note.txt" })).toBe("/tmp/note.txt");
    expect(toolStartSummary("Edit", { file_path: "/tmp/a.ts", old_string: "x" })).toBe("/tmp/a.ts");
    expect(toolStartSummary("Write", { file_path: "/tmp/b.ts", content: "hi" })).toBe("/tmp/b.ts");
    expect(toolStartSummary("NotebookEdit", { file_path: "/tmp/c.ipynb" })).toBe("/tmp/c.ipynb");
    expect(toolStartSummary("Agent", { description: "run echo sub", prompt: "long prompt…" })).toBe("run echo sub");
    expect(toolStartSummary("Task", { description: "the older build's name", prompt: "long prompt…" })).toBe("the older build's name");
    expect(toolStartSummary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolStartSummary("Glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
    expect(toolStartSummary("WebSearch", { query: "hk graduate salary" })).toBe("hk graduate salary");
    expect(toolStartSummary("Sketch", { a: 1 })).toBe('{"a":1}');
    expect(toolStartSummary("Bash", { command: "npm test &&\ngit log" })).toBe("npm test && git log");
    expect(toolStartSummary("Bash", { command: "l".repeat(500) })).toHaveLength(200);
    expect(toolStartSummary("Bash", undefined)).toBe("");
    expect(toolStartSummary("Bash", null)).toBe("");
    // tool_end: strings fold, anything else JSONs, both clipped
    expect(toolEndSummary({ stdout: "one", stderr: "" })).toBe('{"stdout":"one","stderr":""}');
    expect(toolEndSummary("done\nfully")).toBe("done fully");
    expect(toolEndSummary("z".repeat(500))).toHaveLength(300);
    expect(toolEndSummary(undefined)).toBe("");
    expect(toolEndSummary(null)).toBe("");
  });

  it("stripChannelWrapper unwraps only a teledesk wrapper", () => {
    expect(stripChannelWrapper('<channel source="teledesk" message_id="9">hello there</channel>')).toBe("hello there");
    expect(stripChannelWrapper("plain terminal prompt")).toBe("plain terminal prompt");
    const foreign = stripChannelWrapper('<channel source="other" message_id="9">hi</channel>');
    expect(foreign.startsWith('<channel source="other"')).toBe(true);
  });

  it("Stop classifies assistant text from a real transcript file", () => {
    const file = join(tmp(), "turn.jsonl");
    writeFileSync(file, jsonl(asked("go"), said("I ran it."), toolResult("ok"), said("Done.")) + "\n");
    const l = mirrorLinesFor({ hook_event_name: "Stop", session_id: CC, transcript_path: file }, { TELEDESK_MIRROR: TOKEN });
    expect(l.map((m) => m.line.kind)).toEqual(["assistant", "turn_end"]);
    expect(l[0]!.line.kind === "assistant" && l[0]!.line.text).toBe("I ran it.\n\nDone.");
  });

  it("desk_on classifies a history line from a real transcript file", () => {
    const file = join(tmp(), "hist.jsonl");
    writeFileSync(file, jsonl(asked("one"), said("a1"), asked("two"), said("a2")) + "\n");
    const l = mirrorLinesFor(
      { hook_event_name: "PostToolUse", session_id: CC, tool_name: "mcp__teledesk__desk_on", transcript_path: file, tool_response: [{ type: "text", text: "Desk is on" }] },
      { TELEDESK_MIRROR: TOKEN },
    );
    expect(l).toHaveLength(1);
    expect(l[0]!.line.kind === "history" && l[0]!.line.text).toBe("🧑 one\n\n🤖 a1\n\n---\n\n🧑 two\n\n🤖 a2");
  });
});

// ---- daemon: the chat mirror ----

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** The session's persistent channel connection (hello → welcome), as `desk.test.ts` fakes it. */
class DeskChannel {
  got: DaemonMessage[] = [];
  constructor(readonly sock: Socket) {
    const r = new LineReader((l) => { const m = decode(DaemonMessage, l); if (m) this.got.push(m); });
    sock.on("data", (d) => r.push(d));
    sock.on("error", () => { /* the daemon closing is normal */ });
  }
  static connect(path: string): Promise<DeskChannel> {
    return new Promise((resolve, reject) => { const s = createConnection(path, () => resolve(new DeskChannel(s))); s.once("error", reject); });
  }
  send(m: ChannelMessage | object) { this.sock.write(encode(m as ChannelMessage)); }
  async wait(type: DaemonMessage["type"]) { await until(() => this.got.some((m) => m.type === type)); }
}

/** One mirror line the way a hook CLI delivers it: a short-lived connection, write one line,
 * hold it open briefly, then close. Resolves to everything the daemon wrote back ("" when the
 * line was accepted and silently handled or dropped). */
function mirrorSocket(path: string, m: ChannelMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path, () => { s.write(encode(m)); });
    let got = "";
    s.on("data", (d) => { got += d.toString("utf8"); });
    s.on("error", (e) => reject(e));
    s.on("close", () => resolve(got));
    setTimeout(() => s.destroy(), 250);
  });
}

let msgId = 1000;
const say = (text: string, thread: number | undefined) =>
  ({ kind: "message" as const, chatId: GROUP, chatType: "supergroup", fromId: OWNER, messageId: msgId++, threadId: thread, isTopic: thread !== undefined, text });

/** Generous limits for tests about other things, exactly as `desk.test.ts` sets them. */
const ROOMY: Partial<DeskLimits> = { sendsPerMinute: 100_000, startsPerMinute: 100_000, topicsPerMinute: 100_000 };

async function deskSetup(limits?: Partial<DeskLimits>) {
  const dir = tmp();
  const tg = new FakeTelegram();
  const meta = new Map<string, string>();
  const state = new SqliteDeskState(new DatabaseSync(":memory:"), { get: (k) => meta.get(k), set: (k, v) => { meta.set(k, v); }, delete: (k) => { meta.delete(k); } });
  state.setGroup(G);
  const logs: string[] = [];
  const socketPath = join(dir, "desk.sock");
  const router = new DeskRouter({ socketPath, ownerId: String(OWNER), telegram: tg, state, log: (m) => logs.push(m), alive: () => true, limits: { ...ROOMY, ...limits } });
  await router.start();
  cleanups.push(() => router.stop());
  /** A desk session whose hello carries a mirror token: attached, welcomed, with a topic. */
  const open = async (cwd: string, pid: number, token: string) => {
    const c = await DeskChannel.connect(socketPath);
    cleanups.push(() => { c.sock.destroy(); });
    c.send({ type: "hello", cwd, pid, title: cwd.split("/").pop(), mirror_token: token });
    await c.wait("welcome");
    const w = c.got.find((m) => m.type === "welcome")!;
    return { c, topic: state.get(w.session_id)!.topic_id!, sid: w.session_id };
  };
  return { tg, state, logs, router, socketPath, open };
}

describe("daemon chat mirror", () => {
  it("a prompt line posts with the mirror mark", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "hello" }));
    expect(tg.inTopic(d.topic)).toEqual([expect.stringMatching(/Session started/), "🧑 hello"]);
  });

  it("phone-injected text does not echo", async () => {
    const { tg, router, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await router.onUpdate(say("hello", d.topic));
    await d.c.wait("message");
    const n = tg.sent.length;
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: '<channel source="teledesk" message_id="1">hello</channel>' }));
    expect(tg.sent.length).toBe(n);
    // The match was consumed by that one echo: a later terminal-typed prompt of the same text posts.
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "hello" }));
    await until(() => tg.inTopic(d.topic).includes("🧑 hello"));
  });

  it("an assistant line posts with the reply mark, chunked", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    const long = "alpha bravo charlie ".repeat(300); // 6000 chars: past one CHUNK
    await mirrorSocket(socketPath, mirror({ kind: "assistant", text: long }));
    await until(() => tg.inTopic(d.topic).filter((t) => t.startsWith(REPLY_MARK)).length >= 2);
    const parts = tg.inTopic(d.topic).slice(1);
    expect(parts.every((t) => t.startsWith(REPLY_MARK))).toBe(true);
    expect(parts.map((t) => t.slice(REPLY_MARK.length)).join("")).toBe(long);
  });

  it("mirror lines with a foreign cc_session are dropped", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "first" }));
    await until(() => tg.inTopic(d.topic).some((t) => t === "🧑 first"));
    const n = tg.sent.length;
    await mirrorSocket(socketPath, { ...mirror({ kind: "user_prompt", text: "second" }), cc_session: "9d2e8f1a-5b3c-4d6e-9a0f-2c7e8b1d4f30" });
    expect(tg.sent.length).toBe(n);
  });

  it("an unknown token is dropped silently", async () => {
    const { tg, logs, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    const n = tg.sent.length;
    const stranger = "ffffffffffffffffffffffffffffffff";
    const got = await mirrorSocket(socketPath, { ...mirror({ kind: "user_prompt", text: "sneaky" }), token: stranger });
    expect(got).toBe(""); // the hook connection isn't errored
    expect(tg.sent.length).toBe(n); // nothing posted
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(stranger); // the token's value never reaches the log
    expect(allLogs).not.toContain(TOKEN);
    expect(allLogs).not.toContain("sneaky");
  });

  it("history posts once inside the cooldown", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await mirrorSocket(socketPath, mirror({ kind: "history", text: "the earlier chat" }));
    await until(() => tg.inTopic(d.topic).some((t) => t.startsWith("📜 ")));
    await mirrorSocket(socketPath, mirror({ kind: "history", text: "and again" }));
    expect(tg.inTopic(d.topic).filter((t) => t.startsWith("📜 ")).length).toBe(1);
    expect(tg.inTopic(d.topic)[1]).toBe("📜 Recent chat:\n\nthe earlier chat");
  });

  it("history text gets the reply scrub", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    // \u0007 (bell, a control char) and ​ (zero-width space, invisible) come out of transcripts.
    await mirrorSocket(socketPath, mirror({ kind: "history", text: "one\u0007two​ three" }));
    await until(() => tg.inTopic(d.topic).some((t) => t.startsWith("📜 ")));
    expect(tg.inTopic(d.topic).find((t) => t.startsWith("📜 "))).toBe("📜 Recent chat:\n\none two three");
  });

  it("over budget, chat waits but never drops", async () => {
    const { tg, socketPath, open } = await deskSetup({ mirrorSendsPerMinute: 2 });
    const d = await open("/w/proj", 11, TOKEN);
    for (const p of ["one", "two", "three"]) await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: p }));
    await until(() => ["🧑 one", "🧑 two", "🧑 three"].every((m) => tg.inTopic(d.topic).includes(m)));
  });

  it("endSession clears the token mapping", async () => {
    const { tg, state, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    d.c.send({ type: "bye" });
    await until(() => state.get(d.sid)!.status === "offline");
    const got = await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "after the end" }));
    expect(got).toBe("");
    expect(tg.inTopic(d.topic).filter((t) => t.startsWith("🧑 ")).length).toBe(0);
  });
});

// ---- daemon: the order-tolerant tool batch machine ----

describe("tool batches", () => {
  /** Start the turn the way the terminal's hooks do: a prompt line, posted, gate open. */
  const openGate = async (socketPath: string, tg: FakeTelegram, topic: number) => {
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "go" }));
    await until(() => tg.inTopic(topic).includes("🧑 go"));
  };
  const bubbles = (tg: FakeTelegram, prefix: string) => tg.sent.filter((s) => s.text.startsWith(prefix));

  it("three reads collapse into one edited bubble", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    for (const f of ["one.md", "two.md", "three.md"]) {
      await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: f }));
      await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "read it" }));
    }
    // One message for the whole run: a single send, every fold an edit of that same message.
    const run = bubbles(tg, "📖 Read");
    expect(run).toHaveLength(1);
    expect(run[0].text).toBe("📖 Read: one.md");
    expect(tg.edits.every((e) => e.id === run[0].id)).toBe(true);
    expect(tg.edits[tg.edits.length - 1].text).toBe("📖 Read ×3 … read it");
  });

  it("a type change closes the batch and opens a new bubble", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "a.ts" }));
    await until(() => bubbles(tg, "📖 Read").length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "read" }));
    await until(() => tg.edits.length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "ls -la" }));
    await until(() => bubbles(tg, "🖥 Bash").length > 0);
    expect(bubbles(tg, "📖 Read")).toHaveLength(1);
    expect(bubbles(tg, "🖥 Bash")).toHaveLength(1);
    // The Read batch was closed with a final edit of its own bubble, not a new message.
    const closing = tg.edits.find((e) => e.text.startsWith("✅ Read"));
    expect(closing).toBeDefined();
    expect(closing!.text).toBe("✅ Read ×1 — read");
    expect(closing!.id).toBe(bubbles(tg, "📖 Read")[0].id);
  });

  it("turn_end closes the batch; a late tool_start is dropped", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "echo hi" }));
    await until(() => bubbles(tg, "🖥 Bash").length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "turn_end" }));
    await until(() => tg.edits.some((e) => e.text.startsWith("✅ Bash")));
    // The turn is over: its stragglers post nothing — no new bubble, and no edit resurrecting
    // the one that just closed with ✅.
    const n = tg.sent.length;
    const m = tg.edits.length;
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "straggler" }));
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Bash", ok: true, summary: "straggler done" }));
    expect(tg.sent.length).toBe(n);
    expect(tg.edits.length).toBe(m);
    // A new turn reopens the gate, and its tools bubble normally again.
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "again" }));
    await until(() => tg.inTopic(d.topic).includes("🧑 again"));
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "note.md" }));
    await until(() => bubbles(tg, "📖 Read").length > 0);
    expect(bubbles(tg, "📖 Read")[0].text).toBe("📖 Read: note.md");
  });

  it("out-of-order ends never regress the counter", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    // Ends arriving before any start: ephemeral, nothing opens and nothing queues up.
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "early one" }));
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "early two" }));
    expect(bubbles(tg, "📖 Read")).toHaveLength(0);
    expect(tg.edits).toHaveLength(0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "f.ts" }));
    await until(() => bubbles(tg, "📖 Read").length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "done f" }));
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "g.ts" }));
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "done g" }));
    await until(() => tg.edits.length >= 3);
    // Every edit of the one bubble carries a count that never went backwards.
    const counts = tg.edits.map((e) => Number(/×(\d+)/.exec(e.text)?.[1] ?? -1));
    expect(counts.every((c) => c >= 0)).toBe(true);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(bubbles(tg, "📖 Read")).toHaveLength(1);
    expect(tg.edits[tg.edits.length - 1].text).toBe("📖 Read ×2 … done g");
  });

  it("edit failure falls back to a new message and repoints the batch", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "a.ts" }));
    await until(() => bubbles(tg, "📖 Read").length > 0);
    const bubble = bubbles(tg, "📖 Read")[0];
    // The next edit throws once (message deleted, say): the result must not be lost.
    const realEdit = tg.edit.bind(tg);
    let threw = false;
    tg.edit = async (chat: string, id: number, text: string) => {
      if (!threw) { threw = true; throw new Error("telegram editMessageText: Bad Request: message to edit not found"); }
      return realEdit(chat, id, text);
    };
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "result text" }));
    const fallback = tg.sent.find((s) => s.text === "📖 Read ×1 … result text");
    expect(fallback).toBeDefined();
    expect(fallback!.id).not.toBe(bubble.id);
    // The batch now lives at the fallback message: a later end edits that one.
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "second" }));
    await until(() => tg.edits.length > 0);
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0].id).toBe(fallback!.id);
    expect(tg.edits[0].text).toBe("📖 Read ×2 … second");
  });

  it("over budget, tool bubbles drop while chat flows", async () => {
    const { tg, router, socketPath, open } = await deskSetup({ mirrorSendsPerMinute: 1 });
    const d = await open("/w/proj", 11, TOKEN);
    // The gate opens by injection (Ruling 16) instead of a prompt line: at the pinned 1/min an
    // opener would eat the only slot — and this proves injections cost no budget to boot.
    await router.onUpdate(say("go", d.topic));
    await d.c.wait("message");
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "one" })); // takes the one slot, bubbles
    await until(() => bubbles(tg, "🖥 Bash").length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Read", summary: "two" })); // no slot left: bubble skipped entirely
    await until(() => tg.edits.some((e) => e.text.startsWith("✅ Bash"))); // the old run's close was an edit, which costs no budget
    // Its end finds no stored batch, so it folds into nothing.
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Read", ok: true, summary: "two done" }));
    // Chat is never dropped for pacing: it waits and posts. The wait outlasts any late re-post
    // the skipped start might have paced into, so what follows is measured on a settled window:
    await mirrorSocket(socketPath, mirror({ kind: "user_prompt", text: "chat still flows" }));
    await until(() => tg.inTopic(d.topic).includes("🧑 chat still flows"), 4000);
    expect(bubbles(tg, "📖 Read")).toHaveLength(0); // dropped outright — never sent, not even late
    expect(tg.edits).toHaveLength(1); // still just the ✅ close: nothing edits a bubble that never posted
  });

  it("a failed tool closes with ❌", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "false" }));
    await until(() => bubbles(tg, "🖥 Bash").length > 0);
    await mirrorSocket(socketPath, mirror({ kind: "tool_end", tool_name: "Bash", ok: false, summary: "exit 1" }));
    await mirrorSocket(socketPath, mirror({ kind: "turn_end" }));
    await until(() => tg.edits.some((e) => e.text.startsWith("❌")), 4000);
    expect(tg.edits[tg.edits.length - 1].text).toBe("❌ Bash ×1 — exit 1");
  });

  it("the icon table is pinned and an unlisted tool gets the wrench", async () => {
    expect(TOOL_ICONS).toMatchObject({
      Bash: "🖥", Read: "📖", Edit: "✏️", Write: "📝", Grep: "🔍", Glob: "🔍",
      Agent: "🧵", Task: "🧵", WebSearch: "🌐",
    });
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await openGate(socketPath, tg, d.topic);
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Sketch", summary: "a blob" }));
    await until(() => bubbles(tg, "🔧 Sketch").length > 0);
    expect(bubbles(tg, "🔧 Sketch")[0].text).toBe("🔧 Sketch: a blob");
  });

  // Ruling 16: a phone-initiated turn may never fire UserPromptSubmit — the injection itself
  // opens the gate, or that whole turn's tool bubbles would silently drop.
  it("an injected message opens the gate for tool bubbles", async () => {
    const { tg, router, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    await router.onUpdate(say("ping", d.topic));
    await d.c.wait("message");
    await mirrorSocket(socketPath, mirror({ kind: "tool_start", tool_name: "Bash", summary: "ls" }));
    await until(() => bubbles(tg, "🖥 Bash").length > 0);
    expect(bubbles(tg, "🖥 Bash")[0].text).toBe("🖥 Bash: ls");
  });

  // Ruling 17: a bye already in flight on a connection that has just been superseded must not
  // tear down the mirror link the rebind handed to its replacement.
  it("a superseded connection's bye leaves the mirror link standing", async () => {
    const { tg, state, socketPath, open } = await deskSetup({ mirrorSendsPerMinute: 1 });
    const d = await open("/w/proj", 11, TOKEN);
    // Everything the old connection has to say goes in before the rebind — the daemon's queue for
    // it then works through: a posted line, a ~500 ms budget sleep, the bye, and a line after it.
    d.c.send(mirror({ kind: "user_prompt", text: "go" })); // uses the one budget slot
    d.c.send(mirror({ kind: "user_prompt", text: "held up" })); // its handler sleeps, queueing everything behind it
    d.c.send({ type: "bye" });
    d.c.send(mirror({ kind: "user_prompt", text: "after the bye" }));
    const b = await open("/w/proj", 11, TOKEN); // the rebind lands inside that sleep: same row, d is superseded
    expect(b.sid).toBe(d.sid);
    expect(b.topic).toBe(d.topic);
    // The bye's endSession runs against a superseded connection: it must tear down nothing.
    await until(() => tg.inTopic(d.topic).includes("🧑 after the bye"), 4000);
    expect(tg.inTopic(d.topic).includes("🧑 held up")).toBe(true);
    expect(state.get(d.sid)!.status).toBe("live");
  });
});

// ---- installer: the four mirror hooks (Task 9, pure functions) ----

const GUARD = '[ -n "$TELEDESK_MIRROR" ] || exit 0; ';
const FG = GUARD + "teledesk mirror-hook";
const BG = GUARD + "teledesk mirror-hook </dev/stdin >/dev/null 2>&1 & exit 0";
/** Does a matcher group hold one of our hooks? Same rule as the installer: the guard+marker
 * prefix, so a foreign command that merely mentions the marker mid-string doesn't count. */
const holdsOurs = (g: any): boolean => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === "string" && h.command.startsWith(GUARD + HOOK_MARKER));

describe("installer hook entries", () => {
  it("hookEntries: four guarded events, marker in every command, tool events backgrounded", () => {
    const e = hookEntries(true) as any;
    expect(Object.keys(e).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
    expect(e.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: FG }] }]);
    expect(e.Stop).toEqual([{ hooks: [{ type: "command", command: FG }] }]);
    expect(e.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: BG }] }]);
    expect(e.PostToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: BG }] }]);
    // the chat events carry no tool matcher
    expect("matcher" in e.UserPromptSubmit[0]).toBe(false);
    expect("matcher" in e.Stop[0]).toBe(false);
    // backgroundTools:false falls back to the foreground form on the tool events too
    const fg = hookEntries(false) as any;
    expect(fg.PreToolUse[0].hooks[0].command).toBe(FG);
    expect(fg.PostToolUse[0].hooks[0].command).toBe(FG);
  });

  it("merge into an empty settings object yields exactly the four entries", () => {
    expect(mergeHookSettings({}, hookEntries(true))).toEqual({ hooks: hookEntries(true) });
  });

  it("merge into existing unrelated hooks preserves them, other events, and other settings keys", () => {
    const foreign = {
      model: "sonnet",
      permissions: { allow: ["Bash"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 other.py", timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    const merged = mergeHookSettings(foreign, hookEntries(true)) as any;
    expect(merged.model).toBe("sonnet");
    expect(merged.permissions).toEqual({ allow: ["Bash"] });
    // the foreign PreToolUse group is untouched, our group appended
    expect(merged.hooks.PreToolUse[0]).toEqual(foreign.hooks.PreToolUse[0]);
    expect(holdsOurs(merged.hooks.PreToolUse[1])).toBe(true);
    // an event we never install is left completely alone
    expect(merged.hooks.SessionStart).toEqual(foreign.hooks.SessionStart);
    // our other three events were added
    for (const ev of ["UserPromptSubmit", "Stop", "PostToolUse"]) expect(holdsOurs(merged.hooks[ev][0])).toBe(true);
  });

  it("merge is idempotent — the third run's output deep-equals the second's", () => {
    const foreign = { model: "sonnet", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 other.py" }] }] } };
    const entries = hookEntries(true);
    const once = mergeHookSettings(foreign, entries);
    const twice = mergeHookSettings(once, entries);
    const thrice = mergeHookSettings(twice, entries);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    // exactly one marked group per event survives repeated merges
    const m = once as any;
    for (const ev of ["UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse"]) {
      expect(m.hooks[ev].filter(holdsOurs)).toHaveLength(1);
    }
  });

  it("remove strips only marked entries and restores the foreign content exactly", () => {
    const foreign = { model: "sonnet", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 other.py" }] }] } };
    const merged = mergeHookSettings(foreign, hookEntries(true));
    expect(removeHookSettings(merged)).toEqual(foreign);
  });

  it("remove prunes an event that held only our hook, and the hooks object when it empties", () => {
    expect(removeHookSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: FG }] }] } })).toEqual({});
    // a foreign hook sharing our group survives: only the marked hook and any emptied group go
    const mixed = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "foreign" }, { type: "command", command: BG }] }] } };
    expect(removeHookSettings(mixed)).toEqual({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "foreign" }] }] } });
  });

  it("a foreign hook that merely mentions the marker mid-command isn't ours: it survives install and uninstall intact", () => {
    // Ownership is the guard+marker PREFIX, not a substring anywhere: a foreign command that
    // happens to say "teledesk mirror-hook" (logging it, quoting it…) must never be stripped.
    const home = tmp();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    const foreignGroup = { matcher: "Bash", hooks: [{ type: "command", command: "sh -c 'echo seen by the teledesk mirror-hook watcher; exit 0'" }] };
    writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [foreignGroup] } }, null, 2) + "\n");
    expect(install(home).changed.some((c) => c.includes(settings))).toBe(true); // settings.json was written (rc files: expected skips, they don't exist here)
    let s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.hooks.PreToolUse[0]).toEqual(foreignGroup); // untouched, and still first
    expect(s.hooks.PreToolUse.filter(holdsOurs)).toHaveLength(1); // ours was appended, not swapped in over theirs
    uninstall(home);
    s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.hooks.PreToolUse).toEqual([foreignGroup]); // ours stripped, the foreign one byte-for-byte intact
  });
});

// ---- the shipped cycle: the desk is a wiretap, and the reply path is gone ----

const PINNED_INSTRUCTIONS = "The owner can open a Telegram topic for this session with /desk (the desk_on tool) and hide it with /desk off (desk_off).";

describe("mirror cycle", () => {
  it("the whole wiretap, in order: prompt, collapsed reads, a new tool, turn close, answer", async () => {
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    const post = async (line: MirrorMessage["line"]) => { await mirrorSocket(socketPath, mirror(line)); };

    await post({ kind: "user_prompt", text: "make it so" });
    await until(() => tg.inTopic(d.topic).includes("🧑 make it so"));

    for (const f of ["one.md", "two.md", "three.md"]) {
      await post({ kind: "tool_start", tool_name: "Read", summary: f });
      await post({ kind: "tool_end", tool_name: "Read", ok: true, summary: "read it" });
    }
    await post({ kind: "tool_start", tool_name: "Bash", summary: "ls -la" });
    await until(() => tg.sent.some((s) => s.text.startsWith("🖥 Bash")));
    await post({ kind: "turn_end" });
    await until(() => tg.edits.some((e) => e.text.startsWith("✅ Bash")));
    await post({ kind: "assistant", text: "done." });
    await until(() => tg.inTopic(d.topic).includes("🤖 done."));

    // Four messages in the topic, in the order they happened: the run's opener, one bubble for
    // the three reads, the type change's new bubble, the answer. Nothing else was ever sent.
    expect(tg.inTopic(d.topic)).toEqual([
      expect.stringMatching(/^▶️ Session started/),
      "🧑 make it so",
      "📖 Read: one.md",
      "🖥 Bash: ls -la",
      "🤖 done.",
    ]);
    // The Read run: one send, folded by edits, closed ✅ when the Bash start changed the type.
    const read = tg.sent.filter((s) => s.text.startsWith("📖 Read"));
    expect(read).toHaveLength(1);
    expect(tg.edits.filter((e) => e.id === read[0].id).map((e) => e.text)).toEqual([
      "📖 Read ×1 … read it",
      "📖 Read ×2 … two.md",
      "📖 Read ×2 … read it",
      "📖 Read ×3 … three.md",
      "📖 Read ×3 … read it",
      "✅ Read ×3 — read it",
    ]);
    // The Bash bubble closed on turn_end; the batch machine has the last word.
    expect(tg.edits.at(-1)!.text).toBe("✅ Bash ×1 — ls -la");
  }, 20_000);

  it("a stale reply line is ignored, not fatal", async () => {
    // A channel from before this upgrade still sends {"type":"reply",…}. It no longer decodes:
    // the reader answers with one error line and the connection lives on — no crash, nothing posted.
    const { tg, socketPath, open } = await deskSetup();
    const d = await open("/w/proj", 11, TOKEN);
    const n = tg.sent.length;
    d.c.send({ type: "reply", text: "pre-upgrade words" });
    await until(() => d.c.got.some((m) => m.type === "error"));
    expect(d.c.got.find((m) => m.type === "error")).toEqual({ type: "error", reason: "That wasn't a valid desk message." });
    expect(tg.sent.length).toBe(n); // nothing posted
    expect(d.c.sock.destroyed).toBe(false); // and the connection survives…
    d.c.send(mirror({ kind: "assistant", text: "still working" })); // …still working
    await until(() => tg.inTopic(d.topic).includes("🤖 still working"));
    expect(tg.sent.some((s) => s.text.includes("pre-upgrade"))).toBe(false);
  });

  it("ListTools returns exactly desk_on and desk_off; reply is an unknown tool; instructions are one sentence", async () => {
    const { socketPath } = await deskSetup();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const ch = await startDeskChannel({ socketPath, hello: { type: "hello", cwd: "/w/proj", pid: 11, title: "proj", mirror_token: TOKEN }, transport: serverT, backoff: { min: 10, max: 40 } });
    cleanups.push(() => ch.close());
    const client = new Client({ name: "claude-code", version: "1" });
    await client.connect(clientT);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["desk_on", "desk_off"]);
    expect(client.getInstructions()).toBe(PINNED_INSTRUCTIONS);
    const r = (await client.callTool({ name: "reply", arguments: { text: "hi" } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });
});
