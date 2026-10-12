import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Missing TELEGRAM_BOT_TOKEN"),
  TELEGRAM_ALLOWED_USER_ID: z.string().regex(/^\d+$/).transform((s) => Number(s)),
  CLAUDE_BIN: z.string().default("claude"),
  DEFAULT_CWD: z.string(),
  STATE_DIR: z.string(),
  CLAUDE_MODEL: z.string().default("sonnet"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  // Outbound /push HTTP server for scheduled briefs and external pushes.
  PUSH_PORT: z.string().regex(/^\d+$/).default("7421").transform((s) => Number(s)),
  PUSH_SECRET: z.string().min(16, "PUSH_SECRET must be at least 16 chars"),
  // Allowlist for POST /push-document: "key=/abs/path,key2=/abs/path".
  // UNSET = document delivery is off and the endpoint refuses. Callers name a
  // key, never a path, so this is the only place a sendable path can come from.
  PUSH_DOCUMENTS: z.string().optional(),
  // Live-session bridge: route phone messages into Claude Code sessions that
  // are already open in tmux panes, instead of forking them with `claude -p`.
  TMUX_BRIDGE_ENABLED: z
    .string()
    .default("true")
    .transform((s) => !/^(0|false|no|off)$/i.test(s.trim())),
  TMUX_BIN: z.string().default("tmux"),
  // Optional `tmux -L <name>` socket. Unset = the default tmux server.
  TMUX_SOCKET: z.string().optional(),
  // Model for the cheap topic router that picks a session for unpinned messages.
  ROUTER_MODEL: z.string().default("haiku"),
  // Claude Code's config dir (where sessions/ and projects/ live).
  CLAUDE_CONFIG_DIR: z.string().optional(),
});

export const env = envSchema.parse(process.env);
