/** Tests for the mirror protocol line: the token-gated hook message, the launcher
 * that mints the token into the session's child env, the channel hello that carries it,
 * and the mirror-hook CLI that classifies hook JSON and transports the lines. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { ChannelMessage, decode, encode, LineReader, MIRROR_TOKEN, type MirrorMessage } from "../src/desk/protocol.js";
import { MIRROR_TIMEOUT_MS, mirrorLinesFor, runMirrorHook, stripChannelWrapper, type HookInput } from "../src/desk/mirror-hook.js";
import { runClaude } from "../src/desk/launcher.js";
import { REPO_ROOT } from "../src/paths.js";
import { tmp, until } from "./helpers.js";

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

  it("desk_on asks for history, and the stub has none yet", () => {
    // The trigger is wired; Task 6 fills extractHistory. Until then: no tool_end bubble either.
    const l = mirrorLinesFor({ hook_event_name: "PostToolUse", session_id: CC, tool_name: "mcp__teledesk__desk_on", tool_response: [{ type: "text", text: "Desk is on" }] }, env);
    expect(l).toEqual([]);
  });

  it("Stop with the stubbed extractor sends turn_end only", () => {
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
