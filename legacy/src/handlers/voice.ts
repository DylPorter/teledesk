import type { Context } from "grammy";
import { saveAttachmentToVault } from "../lib/vault.js";
import { handleText } from "./text.js";

// For v1 we save the voice note and let Claude decide what to do with it.
// Later: wire up local Whisper / Parakeet for auto-transcription.
export async function handleVoice(ctx: Context): Promise<void> {
  if (!ctx.message?.voice) return;

  const file = await ctx.api.getFile(ctx.message.voice.file_id);
  if (!file.file_path) {
    await ctx.reply("⚠️ Couldn't fetch voice note.");
    return;
  }

  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());

  const savedPath = await saveAttachmentToVault({ buffer, extension: "ogg" });

  await ctx.reply(
    `🎙️ Voice saved: \`${savedPath}\`\n\n_Use gboard voice-to-text to dictate your message._`,
    { parse_mode: "Markdown" },
  );
}
