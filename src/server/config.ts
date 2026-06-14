import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  ARCHIVE_DB_ADAPTER: z.literal("sqlite").default("sqlite"),
  ARCHIVE_DB_PATH: z.string().optional(),
  APP_HOST: z.string().default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().positive().default(3600),
  WAPP_WORK_DIR: z.string().default(".wapp-brain")
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
  workDir
};

export type AppConfig = typeof config;
