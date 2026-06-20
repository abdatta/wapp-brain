import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  ARCHIVE_DB_ADAPTER: z.literal("sqlite").default("sqlite"),
  ARCHIVE_DB_PATH: z.string().optional(),
  APP_HOST: z.string().default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().positive().default(3600),
  WAPP_WORK_DIR: z.string().default(".wapp-brain"),
  LIVE_WHATSAPP_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  LIVE_WHATSAPP_CLIENT: z.enum(["baileys"]).default("baileys"),
  LIVE_MAX_BACKFILL_PER_CHAT_MESSAGES: z.coerce.number().int().positive().default(2000),
  LIVE_MAX_BACKFILL_PER_CHAT_DAYS: z.coerce.number().int().positive().default(14),
  LIVE_MAX_CONCURRENT_CHAT_BACKFILLS: z.coerce.number().int().positive().default(1),
  LIVE_MIN_BACKFILL_DELAY_MS: z.coerce.number().int().positive().default(3000),
  LIVE_MAX_GAP_RETRIES: z.coerce.number().int().positive().default(5),
  WAPP_TRACE_NAME: z.string().optional()
});

const parsed = envSchema.parse(process.env);
const workDir = parsed.WAPP_WORK_DIR;

export const config = {
  archive: {
    adapter: parsed.ARCHIVE_DB_ADAPTER,
    sqlitePath: parsed.ARCHIVE_DB_PATH ?? path.join(workDir, "archive.sqlite")
  },
  app: {
    host: parsed.APP_HOST,
    port: parsed.APP_PORT
  },
  live: {
    enabled: Boolean(parsed.LIVE_WHATSAPP_ENABLED),
    client: parsed.LIVE_WHATSAPP_CLIENT,
    authDir: path.join(workDir, "live", "baileys-auth"),
    spikePath: path.join(workDir, "live", "baileys-spike.json"),
    maxBackfillPerChatMessages: parsed.LIVE_MAX_BACKFILL_PER_CHAT_MESSAGES,
    maxBackfillPerChatDays: parsed.LIVE_MAX_BACKFILL_PER_CHAT_DAYS,
    maxConcurrentChatBackfills: parsed.LIVE_MAX_CONCURRENT_CHAT_BACKFILLS,
    minBackfillDelayMs: parsed.LIVE_MIN_BACKFILL_DELAY_MS,
    maxGapRetries: parsed.LIVE_MAX_GAP_RETRIES
  },
  diagnostics: {
    traceName: parsed.WAPP_TRACE_NAME?.trim() || null,
    traceRootDir: path.join(workDir, "traces")
  },
  workDir
};

export type AppConfig = typeof config;
