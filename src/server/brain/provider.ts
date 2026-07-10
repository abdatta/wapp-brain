// Brain model provider boundary: every model call the brain makes goes
// through generateStructured(), which dispatches to the configured adapter,
// enforces explicit per-provider opt-in, and tracks health so a broken
// provider degrades visibly (extractive-only) instead of silently.
//
// Adapters:
// - claude-cli: spawns the user's Claude Code CLI in single-turn JSON print
//   mode. On this machine the CLI lives inside WSL2, so the default
//   invocation bridges through `wsl.exe -e bash -lc` with the prompt on
//   stdin (no file paths cross the Windows/WSL boundary; a login shell is
//   required so nvm-installed binaries resolve). WAPP_BRAIN_CLAUDE_CMD
//   switches to a native binary.
// - codex: the existing GPT OAuth client, with the response actually parsed.
// - extractive: no model; generateStructured refuses and callers fall back
//   to their extractive path, so assimilation never blocks on a model.
//
// Privacy: prompts, model outputs, and session tokens are never logged.
// Console lines carry provider names, counts, durations, and safe error
// messages only.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrainProviderHealth, BrainProviderName, BrainProviderStatus } from "../../shared/types";
import { config } from "../config";
import { PublicError, publicErrorMessage } from "../privacy";

export type { BrainProviderHealth, BrainProviderName, BrainProviderStatus } from "../../shared/types";

export interface BrainTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BrainGenerationRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  // Per-call model override; defaults to the user's persisted selection.
  model?: string | null;
  timeoutMs?: number;
}

// Selectable models per provider, cheapest-first. The UI offers these; the
// persisted selection is the default for every call until changed.
export const BRAIN_PROVIDER_MODELS: Record<Exclude<BrainProviderName, "extractive">, string[]> = {
  "claude-cli": ["haiku", "sonnet", "opus", "fable"],
  codex: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
};

const DEFAULT_MODEL: Record<Exclude<BrainProviderName, "extractive">, string> = {
  "claude-cli": "haiku",
  codex: "gpt-5.5"
};

export interface BrainGenerationResult {
  json: unknown;
  usage: BrainTokenUsage;
}

interface BrainProviderFileState {
  provider?: BrainProviderName;
  enabled?: Partial<Record<BrainProviderName, boolean>>;
  model?: Partial<Record<BrainProviderName, string>>;
  health?: BrainProviderHealth;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4_000_000;

const emptyHealth = (): BrainProviderHealth => ({
  consecutiveFailures: 0,
  degradedSince: null,
  lastError: null,
  lastOkAt: null
});

function readState(): BrainProviderFileState {
  try {
    return JSON.parse(fs.readFileSync(config.brain.providerConfigPath, "utf8")) as BrainProviderFileState;
  } catch {
    return {};
  }
}

function writeState(state: BrainProviderFileState): void {
  fs.mkdirSync(path.dirname(config.brain.providerConfigPath), { recursive: true });
  const tempPath = `${config.brain.providerConfigPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempPath, config.brain.providerConfigPath);
}

function effectiveProvider(state: BrainProviderFileState): BrainProviderName {
  return state.provider ?? config.brain.provider;
}

function isEnabled(state: BrainProviderFileState, provider: BrainProviderName): boolean {
  if (provider === "extractive") {
    return true;
  }
  return Boolean(state.enabled?.[provider]);
}

export function getBrainProviderStatus(): BrainProviderStatus {
  const state = readState();
  const provider = effectiveProvider(state);
  const health = state.health ?? emptyHealth();
  const enabled = isEnabled(state, provider);
  const modelBacked = provider !== "extractive";
  const degraded = Boolean(health.degradedSince);
  const message = !modelBacked
    ? "Extractive-only: no model provider is enabled; brain output is mechanical but citation-complete."
    : !enabled
      ? `Provider ${provider} is configured but not opted in. Run brain-provider enable-${provider} to allow sending selected evidence to it.`
      : degraded
        ? `Provider ${provider} is DEGRADED since ${health.degradedSince} (${health.consecutiveFailures} consecutive failures; last error: ${health.lastError ?? "unknown"}). Brain output falls back to extractive until a probe succeeds.`
        : health.consecutiveFailures > 0
          ? `Provider ${provider} is enabled but the last ${health.consecutiveFailures} call(s) failed: ${health.lastError ?? "unknown"}`
          : `Provider ${provider} is enabled and healthy.`;
  return {
    provider,
    modelBacked,
    enabled,
    degraded,
    model: modelBacked ? selectedModel(state, provider as Exclude<BrainProviderName, "extractive">) : null,
    models: BRAIN_PROVIDER_MODELS,
    health,
    message
  };
}

function selectedModel(state: BrainProviderFileState, provider: Exclude<BrainProviderName, "extractive">): string {
  return state.model?.[provider] ?? DEFAULT_MODEL[provider];
}

// Models feed a shell string in the WSL bridge; only plain token characters
// pass, everything else is rejected loudly.
function sanitizeModel(model: string): string {
  const trimmed = model.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    throw new PublicError("BRAIN_MODEL_INVALID", "Model names may only contain letters, digits, dots, dashes, and underscores.");
  }
  return trimmed;
}

export function setBrainProviderModel(provider: Exclude<BrainProviderName, "extractive">, model: string): BrainProviderStatus {
  const clean = sanitizeModel(model);
  const state = readState();
  state.model = { ...state.model, [provider]: clean };
  writeState(state);
  return getBrainProviderStatus();
}

export function enableBrainProvider(provider: Exclude<BrainProviderName, "extractive">): BrainProviderStatus {
  const state = readState();
  state.provider = provider;
  state.enabled = { ...state.enabled, [provider]: true };
  state.health = emptyHealth();
  writeState(state);
  return getBrainProviderStatus();
}

export function disableBrainProvider(): BrainProviderStatus {
  const state = readState();
  state.provider = "extractive";
  state.health = emptyHealth();
  writeState(state);
  return getBrainProviderStatus();
}

function recordSuccess(): void {
  const state = readState();
  const wasDegraded = Boolean(state.health?.degradedSince);
  state.health = { consecutiveFailures: 0, degradedSince: null, lastError: null, lastOkAt: new Date().toISOString() };
  writeState(state);
  if (wasDegraded) {
    console.log(`[brain] provider ${effectiveProvider(state)} recovered`);
  }
}

function recordFailure(error: unknown): void {
  const state = readState();
  const health = state.health ?? emptyHealth();
  health.consecutiveFailures += 1;
  health.lastError = publicErrorMessage(error);
  if (!health.degradedSince && health.consecutiveFailures >= config.brain.providerFailureThreshold) {
    health.degradedSince = new Date().toISOString();
    console.error(
      `[brain] provider ${effectiveProvider(state)} DEGRADED after ${health.consecutiveFailures} consecutive failures: ${health.lastError}`
    );
  }
  state.health = health;
  writeState(state);
}

// The one entry point for model-backed generation. Throws PublicError with a
// stable code when generation is unavailable; callers fall back to their
// extractive path and the reason stays visible in provider status.
export async function generateStructured(request: BrainGenerationRequest): Promise<BrainGenerationResult> {
  const state = readState();
  const provider = effectiveProvider(state);
  if (provider === "extractive") {
    throw new PublicError("BRAIN_PROVIDER_EXTRACTIVE", "No model provider is enabled; extractive output only.");
  }
  if (!isEnabled(state, provider)) {
    throw new PublicError(
      "BRAIN_REMOTE_DISABLED",
      `Provider ${provider} requires explicit opt-in before archive-derived evidence is sent to it.`
    );
  }
  if (state.health?.degradedSince) {
    throw new PublicError(
      "BRAIN_PROVIDER_DEGRADED",
      `Provider ${provider} is degraded since ${state.health.degradedSince}; run a probe to attempt recovery.`
    );
  }
  return generateWithHealthTracking(provider, request);
}

// Bypasses the degraded gate: a successful probe clears the degraded state.
export async function probeBrainProvider(): Promise<{ ok: boolean; status: BrainProviderStatus }> {
  const state = readState();
  const provider = effectiveProvider(state);
  if (provider === "extractive" || !isEnabled(state, provider)) {
    return { ok: false, status: getBrainProviderStatus() };
  }
  try {
    const result = await generateWithHealthTracking(provider, {
      system: "You are a health probe. Follow the instruction exactly.",
      user: 'Respond with exactly this JSON and nothing else: {"ok":true}',
      maxOutputTokens: 64,
      timeoutMs: 120_000
    });
    const payload = result.json as { ok?: boolean } | null;
    if (!payload?.ok) {
      throw new PublicError("BRAIN_PROBE_UNEXPECTED", "Probe response did not match the expected shape.");
    }
    return { ok: true, status: getBrainProviderStatus() };
  } catch {
    // recordFailure already ran inside generateWithHealthTracking.
    return { ok: false, status: getBrainProviderStatus() };
  }
}

async function generateWithHealthTracking(
  provider: Exclude<BrainProviderName, "extractive">,
  request: BrainGenerationRequest
): Promise<BrainGenerationResult> {
  const model = sanitizeModel(request.model?.trim() || selectedModel(readState(), provider));
  try {
    const result =
      provider === "claude-cli" ? await generateWithClaudeCli(request, model) : await generateWithCodex(request, model);
    recordSuccess();
    return result;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}

// --- claude-cli adapter ---

export function claudeCliInvocation(model?: string): { command: string; args: string[] } {
  const cliArgs = ["-p", "--output-format", "json", "--max-turns", "1"];
  if (model) {
    // Sanitized upstream: plain token characters only, safe inside the WSL
    // shell string below.
    cliArgs.push("--model", model);
  }
  // Native override: whitespace-split into executable + leading args (paths
  // with spaces are not supported here; keep the binary somewhere plain).
  const native = config.brain.claudeCommand?.trim();
  if (native) {
    const [command, ...leading] = native.split(/\s+/);
    return { command, args: [...leading, ...cliArgs] };
  }
  // WSL bridge: sandbox cwd inside WSL, login shell for PATH, prompt on stdin.
  return {
    command: "wsl.exe",
    args: ["-e", "bash", "-lc", `mkdir -p ~/.wapp-brain-sandbox && cd ~/.wapp-brain-sandbox && claude ${cliArgs.join(" ")}`]
  };
}

interface ClaudeCliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function generateWithClaudeCli(request: BrainGenerationRequest, model: string): Promise<BrainGenerationResult> {
  const { command, args } = claudeCliInvocation(model);
  const prompt = `${request.system}\n\n---\n\n${request.user}\n\nRespond with ONLY the JSON object described above — no prose, no markdown fences. Keep the response under ${request.maxOutputTokens} tokens.`;
  const output = await runChildProcess(command, args, prompt, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // The CLI exits non-zero for platform errors but still writes an envelope
  // whose `result` carries the human-readable reason (quota, auth, rate
  // limit). Parse the envelope FIRST so the real reason reaches health
  // status instead of a bare exit code.
  let envelope: ClaudeCliEnvelope | null = null;
  try {
    envelope = JSON.parse(sliceJsonObject(output.stdout)) as ClaudeCliEnvelope;
  } catch {
    envelope = null;
  }
  if (!envelope) {
    if (output.code !== 0) {
      throw new PublicError("BRAIN_CLI_EXIT", `The model CLI exited with code ${output.code}. ${output.stderrHint}`.trim());
    }
    throw new PublicError("BRAIN_CLI_BAD_ENVELOPE", "The Claude CLI returned output that is not the expected JSON envelope.");
  }
  if (envelope.is_error || envelope.subtype !== "success" || typeof envelope.result !== "string" || output.code !== 0) {
    // envelope.result is a platform diagnostic (never archive content); keep
    // it short and pass it through so the failure explains itself.
    const reason = typeof envelope.result === "string" ? envelope.result.slice(0, 200) : `subtype ${envelope.subtype ?? "unknown"}`;
    const status = envelope.api_error_status ? ` (HTTP ${envelope.api_error_status})` : "";
    throw new PublicError("BRAIN_CLI_ERROR", `The Claude CLI reported an error${status}: ${reason}`);
  }
  return {
    json: parseModelJson(envelope.result),
    usage: {
      inputTokens: Number(envelope.usage?.input_tokens ?? 0),
      outputTokens: Number(envelope.usage?.output_tokens ?? 0)
    }
  };
}

// --- codex adapter (existing OAuth client, response parsed) ---

async function generateWithCodex(request: BrainGenerationRequest, model: string): Promise<BrainGenerationResult> {
  const client = await loadCodexClient();
  const response = (await client.sendMessage(request.user, {
    model,
    instructions: `${request.system}\nRespond with ONLY the requested JSON object — no prose, no markdown fences.`,
    reasoning: { effort: "medium", summary: "auto" },
    text: { verbosity: "low" },
    store: false
  })) as { content?: string };
  if (typeof response?.content !== "string") {
    throw new PublicError("BRAIN_CODEX_BAD_RESPONSE", "The Codex client returned no readable content.");
  }
  return { json: parseModelJson(response.content), usage: { inputTokens: 0, outputTokens: 0 } };
}

interface CodexClientLike {
  connect(): Promise<unknown>;
  sendMessage(prompt: string, options: Record<string, unknown>): Promise<unknown>;
}

// Indirect import defeats TypeScript's static resolution: the package is an
// optional sibling install, mirroring the memory subsystem's Codex loading.
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

async function loadCodexClient(): Promise<CodexClientLike> {
  let moduleExports: { GPTOAuthClient?: new (options: { storagePath: string }) => CodexClientLike };
  try {
    moduleExports = (await dynamicImport("gpt-oauth-client")) as typeof moduleExports;
  } catch {
    try {
      const { pathToFileURL } = await import("node:url");
      const siblingDist = path.resolve(process.cwd(), "..", "gpt-oauth-client", "dist", "index.js");
      moduleExports = (await dynamicImport(pathToFileURL(siblingDist).href)) as typeof moduleExports;
    } catch {
      throw new PublicError("BRAIN_CODEX_UNAVAILABLE", "The Codex OAuth client package is not available.");
    }
  }
  if (!moduleExports.GPTOAuthClient) {
    throw new PublicError("BRAIN_CODEX_UNAVAILABLE", "The Codex OAuth client package is not available.");
  }
  const client = new moduleExports.GPTOAuthClient({ storagePath: config.memory.codexSessionPath });
  await client.connect();
  return client;
}

// --- shared helpers ---

function runChildProcess(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number
): Promise<{ stdout: string; code: number; stderrHint: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new PublicError("BRAIN_CLI_TIMEOUT", `The model CLI did not answer within ${Math.round(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new PublicError("BRAIN_CLI_SPAWN_FAILED", `Could not start the model CLI (${error.message}).`));
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // stderr may carry PATH/auth hints but never prompt content; keep it
      // short. Callers decide how to interpret non-zero exits because the CLI
      // often writes a diagnostic envelope to stdout alongside them.
      resolve({ stdout, code: code ?? -1, stderrHint: stderr.split("\n")[0]?.slice(0, 160) ?? "" });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

// The model is instructed to answer with bare JSON; tolerate stray prose or
// markdown fences by slicing the outermost object.
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(sliceJsonObject(text));
  } catch {
    throw new PublicError("BRAIN_MODEL_OUTPUT_NOT_JSON", "The model response was not parseable JSON.");
  }
}

function sliceJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no JSON object found");
  }
  return text.slice(start, end + 1);
}
