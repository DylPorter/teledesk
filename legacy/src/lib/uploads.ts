/**
 * Groups uploads into one prompt.
 *
 * Telegram sends an album as separate messages sharing a media_group_id, with
 * the caption on the first item only. Handling each message on its own meant
 * one photo reached Claude and the rest were ignored. Uploads in a chat are
 * collected until they stop arriving, then go out as one prompt with every
 * file. Uploads without a caption are held and attached to the next text.
 */

export const HOLD_MS = 10 * 60_000;

type Held = { paths: string[]; at: number };

export class Uploads {
  private readonly batches = new Map<number, { paths: string[]; caption: string; inflight: number }>();
  private readonly held = new Map<number, Held>();

  constructor(private readonly holdMs = HOLD_MS) {}

  /** An upload arrived and its download started. */
  begin(chatId: number, caption?: string): void {
    const b = this.batches.get(chatId) ?? { paths: [], caption: "", inflight: 0 };
    b.inflight++;
    if (caption?.trim()) b.caption = b.caption ? `${b.caption}\n${caption.trim()}` : caption.trim();
    this.batches.set(chatId, b);
  }

  /** A download finished (path is null if it failed). True when none are left in flight. */
  finish(chatId: number, path: string | null): boolean {
    const b = this.batches.get(chatId);
    if (!b) return true;
    b.inflight = Math.max(0, b.inflight - 1);
    if (path) b.paths.push(path);
    return b.inflight === 0;
  }

  /**
   * Close the batch once nothing is in flight. With a caption it returns the
   * prompt to send; without one the files are held for the next text.
   */
  close(chatId: number, now = Date.now()): { paths: string[]; prompt: string | null } | null {
    const b = this.batches.get(chatId);
    if (!b || b.inflight > 0) return null;
    this.batches.delete(chatId);
    if (!b.paths.length) return { paths: [], prompt: null };
    if (b.caption) {
      const paths = [...this.takeHeld(chatId, now), ...b.paths];
      return { paths: b.paths, prompt: buildPrompt(b.caption, paths) };
    }
    const prev = this.takeHeld(chatId, now);
    this.held.set(chatId, { paths: [...prev, ...b.paths], at: now });
    return { paths: b.paths, prompt: null };
  }

  isOpen(chatId: number): boolean {
    return this.batches.has(chatId);
  }

  /** Attach any held uploads to a text message. */
  withHeld(chatId: number, text: string, now = Date.now()): string {
    const paths = this.takeHeld(chatId, now);
    return paths.length ? buildPrompt(text, paths) : text;
  }

  private takeHeld(chatId: number, now: number): string[] {
    const h = this.held.get(chatId);
    this.held.delete(chatId);
    return h && now - h.at <= this.holdMs ? h.paths : [];
  }
}

export function buildPrompt(text: string, paths: string[]): string {
  const files = paths.map((p) => `- ${p}`).join("\n");
  const what = paths.length === 1 ? "this file" : `these ${paths.length} files`;
  return `I sent ${what} from Telegram. Read all of them before answering:\n${files}\n\n${text}`;
}
