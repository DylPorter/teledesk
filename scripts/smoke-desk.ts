/** Smoke test: spawn `bin/teledesk desk-channel` over real stdio, the way Claude Code
 * does, against a real desk router with a fake Telegram. Checks start-up, an owner message
 * reaching the session, a reply reaching the topic, a permission prompt answered by a tap,
 * and the topic closing when the session exits. Touches no real bot and no real data folder.
 *   npm run smoke */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DeskRouter } from "../src/desk/router.js";
import { SqliteDeskState, sqliteMeta } from "../src/desk/state.js";
import type { DeskButton, DeskTelegram } from "../src/desk/types.js";
import { REPO_ROOT } from "../src/paths.js";

const GROUP = "-1001";
const OWNER = "42";
const data = mkdtempSync(join(tmpdir(), "desk-smoke-"));
const db = new DatabaseSync(":memory:");
const state = new SqliteDeskState(db, sqliteMeta(db));
state.setGroup(GROUP);

const sent: { thread?: number; text: string; buttons?: DeskButton[][]; id: number }[] = [];
const closed: number[] = [];
let n = 1;
const tg: DeskTelegram = {
  getMe: async () => ({ id: 1 }), getChat: async () => ({ type: "supergroup", is_forum: true }),
  getChatMember: async () => ({ status: "administrator", can_manage_topics: true }), getChatMemberCount: async () => 2,
  createTopic: async () => 55, editTopic: async () => {}, reopenTopic: async () => {}, deleteTopic: async () => {},
  closeTopic: async (_c, t) => { closed.push(t); },
  send: async (_c, thread, text, buttons) => { const id = n++; sent.push({ thread, text, buttons, id }); return id; },
  edit: async () => {}, typing: async () => {}, answerCallback: async () => {},
};
const router = new DeskRouter({ socketPath: join(data, "desk.sock"), ownerId: OWNER, telegram: tg, state, log: (m) => console.log("router:", m) });
await router.start();

const wait = async (what: string, f: () => boolean) => {
  const end = Date.now() + 8000;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const ok = (m: string) => console.log(`✓ ${m}`);

const transport = new StdioClientTransport({
  command: join(REPO_ROOT, "bin", "teledesk"), args: ["desk-channel"], stderr: "inherit",
  env: { ...process.env as Record<string, string>, TELEDESK: "1", TELEDESK_DATA_DIR: data, CLAUDE_PROJECT_DIR: REPO_ROOT },
});
const client = new Client({ name: "smoke", version: "1" });
const chat: { content: string; meta: Record<string, string> }[] = [];
const verdicts: { request_id: string; behavior: string }[] = [];
client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.any() }), (x) => { chat.push(x.params); });
client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel/permission"), params: z.any() }), (x) => { verdicts.push(x.params); });

try {
  const t0 = Date.now();
  await client.connect(transport);
  const caps = client.getServerCapabilities()?.experimental ?? {};
  if (!("claude/channel" in caps) || !("claude/channel/permission" in caps)) throw new Error(`missing channel capabilities: ${JSON.stringify(caps)}`);
  ok(`channel server started in ${Date.now() - t0} ms with both channel capabilities`);

  // Dormant until desk_on: no topic, reply refused.
  await new Promise((r) => setTimeout(r, 400));
  if (sent.some((s) => s.text.startsWith("▶️ Session started"))) throw new Error("the channel attached before desk_on");
  const refused = await client.callTool({ name: "reply", arguments: { text: "early" } }) as { content: { text: string }[]; isError?: boolean };
  if (!refused.isError) throw new Error("reply worked while the desk was dormant");
  ok("dormant until /desk: no topic, reply refused");

  const on = await client.callTool({ name: "desk_on", arguments: {} }) as { content: { text: string }[]; isError?: boolean };
  if (on.isError) throw new Error(`desk_on failed: ${on.content[0].text}`);
  ok(`desk_on: ${on.content[0].text}`);
  await wait("Session started", () => sent.some((s) => s.text.startsWith("▶️ Session started")));
  ok("session got its topic");

  await router.onUpdate({ kind: "message", chatId: Number(GROUP), chatType: "supergroup", fromId: Number(OWNER), messageId: 9, threadId: 55, isTopic: true, text: "ping" });
  await wait("channel notification", () => chat.length > 0);
  ok(`owner message reached the session: ${JSON.stringify(chat[0])}`);

  const r = await client.callTool({ name: "reply", arguments: { text: "pong" } }) as { content: { text: string }[] };
  if (r.content[0].text !== "sent") throw new Error(`reply returned ${JSON.stringify(r)}`);
  await wait("reply in topic", () => sent.some((s) => s.thread === 55 && s.text === "🤖 pong"));
  ok("reply reached the topic, marked as Claude's");

  await (client as unknown as { notification(x: unknown): Promise<void> }).notification({
    method: "notifications/claude/channel/permission_request",
    params: { request_id: "qwert", tool_name: "Bash", description: "List files", input_preview: "{\"command\":\"ls\"}" },
  });
  await wait("permission prompt", () => sent.some((s) => s.buttons));
  const prompt = sent.find((s) => s.buttons)!;
  await router.onUpdate({ kind: "callback", id: "cb", chatId: Number(GROUP), fromId: Number(OWNER), messageId: prompt.id, data: prompt.buttons![0][0].data, text: prompt.text });
  await wait("verdict", () => verdicts.length > 0);
  ok(`tap became a verdict: ${JSON.stringify(verdicts[0])}`);

  await client.close(); // stdin closes, as when Claude Code exits
  await wait("topic closed", () => closed.includes(55));
  ok("session exit posted Session ended and closed the topic");
  console.log("smoke: all good");
} finally {
  await router.stop();
}
