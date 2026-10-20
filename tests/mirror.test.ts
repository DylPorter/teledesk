/** Tests for the mirror protocol line: the token-gated hook message, the launcher
 * that mints the token into the session's child env, and the channel hello that carries it. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { ChannelMessage, decode, encode, MIRROR_TOKEN, type MirrorMessage } from "../src/desk/protocol.js";
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
