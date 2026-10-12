import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

const VAULT_ROOT = env.DEFAULT_CWD;
const INBOX_ATTACHMENTS = path.join(VAULT_ROOT, "Resources", "Attachments");
const INBOX_QUICK_CAPTURE = path.join(VAULT_ROOT, "Inbox", "Quick Capture.md");

export async function saveAttachmentToVault(opts: {
  buffer: Buffer;
  extension: string;
  caption?: string;
  /** Keeps files saved in the same millisecond (an album) from overwriting each other. */
  suffix?: string;
}): Promise<string> {
  await mkdir(INBOX_ATTACHMENTS, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `telegram-${timestamp}${opts.suffix ? `-${opts.suffix}` : ""}.${opts.extension}`;
  const filepath = path.join(INBOX_ATTACHMENTS, filename);
  await writeFile(filepath, opts.buffer);
  return filepath;
}

export async function appendToQuickCapture(entry: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  let current = "";
  try {
    current = await readFile(INBOX_QUICK_CAPTURE, "utf8");
  } catch {
    current = "# Quick Capture\n\n";
  }
  const now = new Date().toISOString();
  const block = `\n### ${now}\n${entry}\n`;
  await writeFile(INBOX_QUICK_CAPTURE, current + block);
}
