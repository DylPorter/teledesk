/** Tests for the mirror protocol line: the token-gated hook message. */
import { describe, expect, it } from "vitest";
import { ChannelMessage, decode, encode, type MirrorMessage } from "../src/desk/protocol.js";

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
