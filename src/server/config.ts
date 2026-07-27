import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

// Demo mode (`WAPP_DEMO=1`) pivots every path the app owns into an isolated
// demo workspace and forbids external side effects. It is resolved BEFORE
// schema parsing so path-bearing overrides can be dropped outright: a demo
// process must be incapable of touching the real workspace no matter what the
// environment says. Port stays overridable — only its default moves, so a demo
// instance can run beside the real server.
const DEMO_WORK_DIR = ".wapp-brain-demo";
const DEMO_IGNORED_ENV = ["WAPP_WORK_DIR", "ARCHIVE_DB_PATH", "WAPP_MEMORY_DIR", "WAPP_MEMORY_CODEX_SESSION_PATH"] as const;
const demoMode = process.env.WAPP_DEMO === "1" || process.env.WAPP_DEMO === "true";
const env: NodeJS.ProcessEnv = { ...process.env };
if (demoMode) {
  // WAPP_DEMO_DIR is the one demo-path knob (tests and relocations); it must
  // never collide with the real workspace — neither the env-configured one
  // nor the default — or the isolation guarantee would be an env var away
  // from meaningless.
  const demoDir = env.WAPP_DEMO_DIR?.trim() || DEMO_WORK_DIR;
  const realWorkDirs = [env.WAPP_WORK_DIR ?? ".wapp-brain", ".wapp-brain"];
  if (realWorkDirs.some((realDir) => path.resolve(demoDir) === path.resolve(realDir))) {
    throw new Error(`WAPP_DEMO_DIR must not point at the real workspace (${demoDir}).`);
  }
  for (const key of DEMO_IGNORED_ENV) {
    delete env[key];
  }
  env.WAPP_WORK_DIR = demoDir;
  env.WAPP_BRAIN_PROVIDER = "extractive";
  env.WAPP_MEMORY_PROVIDER = "local";
  env.WAPP_MEMORY_REMOTE_MODEL_ENABLED = "0";
  env.LIVE_AUTO_RESUME = "0";
  env.APP_PORT = env.APP_PORT ?? "3610";
}

const envSchema = z.object({
  ARCHIVE_DB_ADAPTER: z.literal("sqlite").default("sqlite"),
  ARCHIVE_DB_PATH: z.string().optional(),
  APP_HOST: z.string().default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().positive().default(3600),
  WAPP_WORK_DIR: z.string().default(".wapp-brain"),
  LIVE_AUTO_RESUME: z
    .string()
    .optional()
    .transform((value) => value !== "0" && value !== "false"),
  LIVE_WHATSAPP_CLIENT: z.enum(["baileys"]).default("baileys"),
  LIVE_MAX_BACKFILL_PER_CHAT_MESSAGES: z.coerce.number().int().positive().default(2000),
  LIVE_MAX_BACKFILL_PER_CHAT_DAYS: z.coerce.number().int().positive().default(34),
  LIVE_MAX_CONCURRENT_CHAT_BACKFILLS: z.coerce.number().int().positive().default(3),
  LIVE_MIN_BACKFILL_DELAY_MS: z.coerce.number().int().positive().default(3000),
  LIVE_MAX_GAP_RETRIES: z.coerce.number().int().positive().default(5),
  LIVE_RECOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  LIVE_AUDIT_SETTLE_MS: z.coerce.number().int().nonnegative().default(60_000),
  // Brain (tiered assimilation) settings. The provider default is extractive:
  // model-backed generation is an explicit per-provider opt-in.
  WAPP_BRAIN_PROVIDER: z.enum(["claude-cli", "codex", "extractive"]).default("extractive"),
  // Automatic consolidation is opt-in: "paused" (default) computes due work
  // and alerts, but only user-triggered runs spend model budget.
  WAPP_BRAIN_SCHEDULER: z.enum(["paused", "auto"]).default("paused"),
  // Command that reaches the Claude Code CLI. On this machine the CLI lives
  // inside WSL2, so the default bridges through wsl.exe with a login shell so
  // nvm/npm-installed binaries resolve. Prompts always travel over stdin.
  WAPP_BRAIN_CLAUDE_CMD: z.string().optional(),
  WAPP_BRAIN_CUTOFF_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  WAPP_BRAIN_VOLUME_TRIGGER: z.coerce.number().int().positive().default(50),
  WAPP_BRAIN_SIGNIFICANCE_MIN: z.coerce.number().int().positive().default(5),
  WAPP_BRAIN_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(200),
  WAPP_BRAIN_MAX_CALLS_PER_HOUR: z.coerce.number().int().positive().default(30),
  WAPP_BRAIN_MAX_EVIDENCE_MESSAGES: z.coerce.number().int().positive().default(150),
  // Hard cap on an episode's time span, enforced inside buildEvidencePacks so a
  // quiet chat's sparse backlog produces week-bounded episodes instead of one
  // spanning months. Independent of the scheduler's significance/volume gates.
  WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS: z.coerce.number().int().positive().default(7),
  WAPP_BRAIN_PROVIDER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Identity late-resolution is deterministic and model-free by design. When a
  // provider is configured, optionally enqueue low-priority regeneration for
  // repaired episodes so the model can weave the now-named person into context.
  // Off by default: the deterministic repair alone keeps the brain honest.
  WAPP_BRAIN_REGENERATE_AFTER_RESOLUTION: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  WAPP_MEMORY_DIR: z.string().optional(),
  WAPP_MEMORY_PROVIDER: z.enum(["local", "codex"]).default("local"),
  WAPP_MEMORY_REMOTE_MODEL_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  WAPP_MEMORY_CODEX_SESSION_PATH: z.string().optional(),
  WAPP_MEMORY_DEFAULT_CUTOFF_HOUR: z.coerce.number().int().min(0).max(23).default(0),
  WAPP_MEMORY_MAX_EVIDENCE_MESSAGES: z.coerce.number().int().positive().default(400),
  WAPP_MEMORY_MAX_QUERY_MESSAGES: z.coerce.number().int().positive().default(40),
  WAPP_TRACE_NAME: z.string().optional(),
  GOOGLE_CONTACTS_CLIENT_ID: z.string().optional(),
  GOOGLE_CONTACTS_CLIENT_SECRET: z.string().optional(),
  // Two-level person model: a pending suggestion at or above this score may
  // surface as a display-level "possibly the same as …" hint. Display only —
  // hints never reach claims, prompts, or search.
  WAPP_PERSONS_HINT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  // How many recovery ticks between suggestion-detector passes (auto-connect
  // runs every tick; detectors are heavier and recompute from state).
  WAPP_PERSONS_DETECTOR_TICK_INTERVAL: z.coerce.number().int().positive().default(10)
});

const parsed = envSchema.parse(env);
const workDir = parsed.WAPP_WORK_DIR;
const memoryRootDir = parsed.WAPP_MEMORY_DIR ?? path.join(workDir, "memory");

export const config = {
  archive: {
    adapter: parsed.ARCHIVE_DB_ADAPTER,
    sqlitePath: parsed.ARCHIVE_DB_PATH ?? path.join(workDir, "archive.sqlite")
  },
  app: {
    host: parsed.APP_HOST,
    port: parsed.APP_PORT
  },
  media: {
    // Content-addressed decrypted media blobs beside archive.sqlite; the whole
    // workDir (and any media/ directory) is gitignored.
    rootDir: path.join(workDir, "media")
  },
  live: {
    autoResume: Boolean(parsed.LIVE_AUTO_RESUME ?? true),
    client: parsed.LIVE_WHATSAPP_CLIENT,
    authDir: path.join(workDir, "live", "baileys-auth"),
    spikePath: path.join(workDir, "live", "baileys-spike.json"),
    maxBackfillPerChatMessages: parsed.LIVE_MAX_BACKFILL_PER_CHAT_MESSAGES,
    maxBackfillPerChatDays: parsed.LIVE_MAX_BACKFILL_PER_CHAT_DAYS,
    maxConcurrentChatBackfills: parsed.LIVE_MAX_CONCURRENT_CHAT_BACKFILLS,
    minBackfillDelayMs: parsed.LIVE_MIN_BACKFILL_DELAY_MS,
    maxGapRetries: parsed.LIVE_MAX_GAP_RETRIES,
    recoveryIntervalMs: parsed.LIVE_RECOVERY_INTERVAL_MS,
    auditSettleMs: parsed.LIVE_AUDIT_SETTLE_MS
  },
  brain: {
    rootDir: path.join(workDir, "brain"),
    providerConfigPath: path.join(workDir, "brain", "provider.json"),
    provider: parsed.WAPP_BRAIN_PROVIDER,
    scheduler: parsed.WAPP_BRAIN_SCHEDULER,
    claudeCommand: parsed.WAPP_BRAIN_CLAUDE_CMD ?? null,
    cutoffHour: parsed.WAPP_BRAIN_CUTOFF_HOUR,
    volumeTrigger: parsed.WAPP_BRAIN_VOLUME_TRIGGER,
    significanceMin: parsed.WAPP_BRAIN_SIGNIFICANCE_MIN,
    maxCallsPerDay: parsed.WAPP_BRAIN_MAX_CALLS_PER_DAY,
    maxCallsPerHour: parsed.WAPP_BRAIN_MAX_CALLS_PER_HOUR,
    maxEvidenceMessages: parsed.WAPP_BRAIN_MAX_EVIDENCE_MESSAGES,
    maxEpisodeSpanDays: parsed.WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS,
    maxEpisodeSpanMs: parsed.WAPP_BRAIN_MAX_EPISODE_SPAN_DAYS * 24 * 60 * 60_000,
    providerFailureThreshold: parsed.WAPP_BRAIN_PROVIDER_FAILURE_THRESHOLD,
    regenerateAfterResolution: parsed.WAPP_BRAIN_REGENERATE_AFTER_RESOLUTION
  },
  memory: {
    rootDir: memoryRootDir,
    pagesDir: path.join(memoryRootDir, "pages"),
    citationsDir: path.join(memoryRootDir, "citations"),
    runsDir: path.join(memoryRootDir, "runs"),
    providerConfigPath: path.join(memoryRootDir, "provider.json"),
    codexSessionPath: parsed.WAPP_MEMORY_CODEX_SESSION_PATH ?? path.join(memoryRootDir, "codex-session.json"),
    provider: parsed.WAPP_MEMORY_PROVIDER,
    remoteModelEnabled: Boolean(parsed.WAPP_MEMORY_REMOTE_MODEL_ENABLED),
    defaultCutoffHour: parsed.WAPP_MEMORY_DEFAULT_CUTOFF_HOUR,
    maxEvidenceMessages: parsed.WAPP_MEMORY_MAX_EVIDENCE_MESSAGES,
    maxQueryMessages: parsed.WAPP_MEMORY_MAX_QUERY_MESSAGES
  },
  diagnostics: {
    traceName: parsed.WAPP_TRACE_NAME?.trim() || null,
    traceRootDir: path.join(workDir, "traces")
  },
  googleContacts: {
    clientId: parsed.GOOGLE_CONTACTS_CLIENT_ID?.trim() || null,
    clientSecret: parsed.GOOGLE_CONTACTS_CLIENT_SECRET?.trim() || null,
    callbackUrl: `http://${parsed.APP_HOST}:${parsed.APP_PORT}/api/google-contacts/oauth/callback`,
    credentialsPath: path.join(workDir, "google-contacts-auth.json")
  },
  persons: {
    hintScoreThreshold: parsed.WAPP_PERSONS_HINT_THRESHOLD,
    detectorTickInterval: parsed.WAPP_PERSONS_DETECTOR_TICK_INTERVAL
  },
  demo: demoMode,
  workDir
};

export type AppConfig = typeof config;
