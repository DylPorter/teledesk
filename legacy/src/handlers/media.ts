import type { Context } from "grammy";
import { Uploads } from "../lib/uploads.js";
import { saveAttachmentToVault } from "../lib/vault.js";
import { bridgeEnabled, rememberBotReply, routeText } from "./bridge.js";
import { handleText } from "./text.js";

// Wait this long after the last upload before treating the batch as complete.
const QUIET_MS = 1500;
// Bot API getFile refuses files above 20 MB.
const MAX_BYTES = 20 * 1024 * 1024;

export const uploads = new Uploads();
const timers = new Map<number, NodeJS.Timeout>();

function send(ctx: Context, prompt: string): Promise<void> {
  return bridgeEnabled ? routeText(ctx, prompt) : handleText(ctx, prompt, { onSent: rememberBotReply });
}

/** Photos and documents, single or as an album. */
export async function handleMedia(ctx: Context): Promise<void> {
  const msg = ctx.message;
  const chatId = ctx.chat?.id;
  if (!msg || !chatId) return;

  const photo = msg.photo?.at(-1); // Telegram sends several sizes; take the largest.
  const doc = msg.document;
  const fileId = photo?.file_id ?? doc?.file_id;
  if (!fileId) return;

  clearTimeout(timers.get(chatId));
  uploads.begin(chatId, msg.caption);

  let saved: string | null = null;
  try {
    if ((doc?.file_size ?? 0) > MAX_BYTES) throw new Error(`${doc?.file_name ?? "file"} is over 20 MB`);
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file path");
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const name = doc?.file_name ?? file.file_path;
    saved = await saveAttachmentToVault({
      buffer: Buffer.from(await res.arrayBuffer()),
      extension: name.includes(".") ? name.split(".").pop()! : photo ? "jpg" : "bin",
      suffix: String(msg.message_id),
    });
  } catch (e) {
    await ctx.reply(`⚠️ Couldn't save an upload: ${(e as Error).message}`).catch(() => {});
  }

  if (!uploads.finish(chatId, saved)) return;
  timers.set(
    chatId,
    setTimeout(() => {
      timers.delete(chatId);
      void flush(ctx, chatId).catch((e) => console.error("[media]", e));
    }, QUIET_MS),
  );
}

/** Let a text sent right after an album wait for the album, so it attaches. */
export async function settleUploads(chatId: number, maxMs = 60_000): Promise<void> {
  const until = Date.now() + maxMs;
  while ((timers.has(chatId) || uploads.isOpen(chatId)) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function flush(ctx: Context, chatId: number): Promise<void> {
  const batch = uploads.close(chatId);
  if (!batch?.paths.length) return;
  const n = batch.paths.length;
  const saved = `📎 Saved ${n} file${n === 1 ? "" : "s"} to Resources/Attachments.`;
  if (batch.prompt) {
    await ctx.reply(saved);
    await send(ctx, batch.prompt);
  } else {
    await ctx.reply(`${saved} Send a message and I'll include ${n === 1 ? "it" : "them"}.`);
  }
}
