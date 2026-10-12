/**
 * Bot message id → where a Telegram reply to that message should go.
 *
 * Both sides must be recorded: a pane's answers, and answers from the bot's
 * own `claude -p` session. If only panes are recorded, a reply to a bot
 * answer falls through to the router and can land in an unrelated pane.
 */

export type ReplyTarget =
  | { kind: "pane"; paneId: string; label: string }
  | { kind: "bot" };

export class ReplyTargets {
  private readonly targets = new Map<number, ReplyTarget>();

  constructor(private readonly max = 1000) {}

  remember(messageId: number | null, target: ReplyTarget): void {
    if (messageId === null) return;
    this.targets.delete(messageId);
    this.targets.set(messageId, target);
    if (this.targets.size > this.max) this.targets.delete(this.targets.keys().next().value!);
  }

  get(messageId: number | undefined): ReplyTarget | undefined {
    return messageId === undefined ? undefined : this.targets.get(messageId);
  }
}
