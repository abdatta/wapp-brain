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
import type { BrainProviderHealth, BrainProviderName, BrainProviderStatus, BrainReasoningEffort } from "../../shared/types";
import { config } from "../config";
import { PublicError, publicErrorMessage, redactForDisplay } from "../privacy";
import { toWellFormedText } from "../text";

export type { BrainProviderHealth, BrainProviderName, BrainProviderStatus, BrainReasoningEffort } from "../../shared/types";

export interface BrainTokenUsage {
  inputTokens: number;
  outputTokens: number;
  // True when the provider surfaced no usage object and the tokens are a
  // character-based estimate; the ledger flags such rows rather than trusting
  // them as measured (and never records a silent zero for a real call).
  estimated?: boolean;
}

// chars/4 is the conventional rough token estimate; only used when a provider
// gives us no real usage object.
function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export interface BrainGenerationRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  // Diagnostic label for the call site (e.g. "episode", "rollup"). Never sent to
  // a provider; used only so a well-formedness repair names which builder
  // produced malformed text.
  purpose?: string;
  // Per-call model override; defaults to the user's persisted selection.
  model?: string | null;
  // Per-call reasoning-effort override for providers with an effort knob
  // (codex only; the claude-cli print mode has no equivalent flag).
  effort?: BrainReasoningEffort;
  timeoutMs?: number;
}

// Selectable models per provider, cheapest-first, as EXPLICIT model ids —
// bare CLI aliases like "sonnet" resolve to whatever that CLI version
// considers current, which must never silently change what stamps permanent
// episodes. The UI offers these; the persisted selection is the default for
// every call until changed.
export const BRAIN_PROVIDER_MODELS: Record<Exclude<BrainProviderName, "extractive">, string[]> = {
  "claude-cli": ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"],
  codex: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]
};

// Sonnet 5 / Terra defaults: episode digests are comprehension + citation-
// discipline work where the mid tier already matches the flagship on what
// digests need — long-context recall (Terra 89.6 vs Sol 91.5 MRCR) — at half
// the subscription rate-window burn; Sol's edge only shows on long-horizon
// agentic tasks digests never exercise. Haiku stays selectable for turbo
// backfill; Fable/Opus and Sol are better saved for low-volume rollup calls.
// Luna is deliberately last-resort: its long-context cliff (41.3 MRCR
// 8-needle) risks missed citations in permanent episodes.
const DEFAULT_MODEL: Record<Exclude<BrainProviderName, "extractive">, string> = {
  "claude-cli": "claude-sonnet-5",
  codex: "gpt-5.6-terra"
};

// Medium is enough for bounded digest calls (≤150-message packs, 1200-token
// JSON answers); deeper effort only pays on long-horizon synthesis, which
// future rollup calls can request per call via BrainGenerationRequest.effort.
const DEFAULT_CODEX_REASONING_EFFORT: BrainReasoningEffort = "medium";

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

// Statuses where the provider is reachable and refusing THIS payload: the
// request is malformed, oversized, or unprocessable. Deliberately excludes 401
// and 403 (auth — the provider is refusing US, not this payload) and 429 (usage
// limit — the same payload succeeds later). Those stay transient, so they still
// count toward degradation as before.
const DETERMINISTIC_REJECTION_STATUSES = new Set([400, 413, 422]);

// A failure that is deterministic in the request: retrying byte-identical input
// cannot succeed, and the provider proved it is alive by answering at all.
// Callers quarantine the offending work instead of treating the provider as
// unavailable.
export class BrainProviderRejection extends PublicError {
  public readonly httpStatus: number;

  constructor(httpStatus: number, safeMessage: string) {
    super("BRAIN_PROVIDER_REJECTED_REQUEST", safeMessage);
    this.name = "BrainProviderRejection";
    this.httpStatus = httpStatus;
  }
}

export function isDeterministicRejection(error: unknown): error is BrainProviderRejection {
  return error instanceof BrainProviderRejection;
}

// Maps an adapter failure onto the taxonomy. `status` is whatever the adapter
// could observe (a parsed `API Error <status>` prefix, or the CLI envelope's
// api_error_status); null means the adapter saw no status and the failure stays
// transient by default — an unknown failure must never be assumed permanent.
export function classifyProviderFailure(status: number | null, error: unknown, detail: string): unknown {
  if (status == null || !DETERMINISTIC_REJECTION_STATUSES.has(status)) {
    return error;
  }
  return new BrainProviderRejection(
    status,
    `The model provider rejected this request (HTTP ${status}) and will reject it identically on retry: ${detail}`
  );
}

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
  const sessionMissing = provider === "codex" && enabled && !codexSessionExists();
  const message = !modelBacked
    ? "Extractive-only: no model provider is enabled; brain output is mechanical but citation-complete."
    : !enabled
      ? `Provider ${provider} is configured but not opted in. Run brain-provider enable-${provider} to allow sending selected evidence to it.`
      : sessionMissing
        ? "Codex is enabled but has no local session. Run `npm run brain:provider -- login-codex` in a terminal (interactive OAuth) before running."
        : degraded
        ? `Provider ${provider} is DEGRADED since ${health.degradedSince} (${health.consecutiveFailures} consecutive failures; last error: ${health.lastError ?? "unknown"}). Brain output falls back to extractive until a probe succeeds.`
        : health.consecutiveFailures > 0
          ? `Provider ${provider} is enabled but the last ${health.consecutiveFailures} call(s) failed: ${health.lastError ?? "unknown"}`
          : `Provider ${provider} is enabled and healthy.`;
  return {
    provider,
    modelBacked,
    enabled,
    sessionMissing,
    degraded,
    model: modelBacked ? selectedModel(state, provider as Exclude<BrainProviderName, "extractive">) : null,
    reasoningEffort: provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null,
    models: BRAIN_PROVIDER_MODELS,
    // Token-usage accuracy for budget surfaces: the claude CLI envelope carries
    // a real usage object; codex falls back to character estimates when the
    // stream surfaces none. Extractive makes no calls at all.
    tokenUsage: !modelBacked ? "none" : provider === "claude-cli" ? "exact" : "may-estimate",
    health,
    message
  };
}

// The MEASURED reason a provider latched degraded: its consecutive-failure
// count plus the actual last error from health tracking — not a guess. Run
// interrupt messages embed this so an operator sees the real cause (e.g.
// `API Error 400: {"detail":"Bad Request"}`, a timeout, or a genuine
// usage-limit envelope) instead of a hardcoded "usage limit, outage, or auth"
// triad that was never inspected. Returns "" when the provider is not currently
// degraded (health has since cleared), so callers can fall back to a generic
// phrase.
export function brainProviderDegradationReason(): string {
  const { health } = getBrainProviderStatus();
  if (!health.degradedSince) {
    return "";
  }
  const failures = `${health.consecutiveFailures} consecutive failure(s)`;
  return health.lastError ? `${failures}; last error: ${health.lastError}` : failures;
}

// A stored OAuth session is a hard precondition for codex calls: without one
// the client's connect() would start an INTERACTIVE login flow inside the
// server (observed blocking the event loop). Login is a CLI-only action.
export function codexSessionExists(): boolean {
  try {
    return fs.existsSync(config.memory.codexSessionPath);
  } catch {
    return false;
  }
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

// Well-formedness guard: no request leaves this process carrying an unpaired
// surrogate, whichever builder produced the text. Fixing the known truncation
// sites fixes today's defect; this makes the class unrepresentable, because
// rollup, lifecycle, and any future prompt builder all funnel through here.
//
// A correct builder never trips this, so a repair is a DEFECT SIGNAL, not
// routine operation — it is logged loudly. Per the provider privacy contract the
// log carries the call's purpose and counts only, never prompt content.
export function wellFormedRequest(request: BrainGenerationRequest): BrainGenerationRequest {
  const system = toWellFormedText(request.system);
  const user = toWellFormedText(request.user);
  if (system === request.system && user === request.user) {
    return request;
  }
  // Replacement is 1:1 in code units, so differing positions count the repairs.
  const repaired = countDifferences(request.system, system) + countDifferences(request.user, user);
  console.error(
    `[brain] prompt well-formedness guard repaired ${repaired} unpaired surrogate(s) in a ${request.purpose ?? "unlabelled"} call — a prompt builder emitted malformed text`
  );
  return { ...request, system, user };
}

function countDifferences(before: string, after: string): number {
  let count = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      count += 1;
    }
  }
  return count;
}

async function generateWithHealthTracking(
  provider: Exclude<BrainProviderName, "extractive">,
  rawRequest: BrainGenerationRequest
): Promise<BrainGenerationResult> {
  const request = wellFormedRequest(rawRequest);
  const model = sanitizeModel(request.model?.trim() || selectedModel(readState(), provider));
  try {
    const result =
      provider === "claude-cli" ? await generateWithClaudeCli(request, model) : await generateWithCodex(request, model);
    recordSuccess();
    return result;
  } catch (error) {
    // A deterministic rejection proves the provider is reachable and answering
    // — it refused this payload. Counting it as a health failure latches a
    // HEALTHY provider as degraded and halts the whole run over content it will
    // never accept. Health tracks availability; this is not an availability
    // signal, so it is deliberately left out of it.
    if (!isDeterministicRejection(error)) {
      recordFailure(error);
    }
    throw error;
  }
}

// --- claude-cli adapter ---

// wsl.exe's stdin relay drops with a connection error (Wsl/Service/0x8007274c,
// UTF-16 text on stdout) when a multi-kilobyte prompt is written and the pipe
// closed before the relay socket is up — tiny probe prompts squeak through,
// real episode prompts never arrive. bash therefore announces readiness on
// stderr and runChildProcess holds the prompt until the marker is seen.
const WSL_STDIN_READY_MARKER = "__WAPP_BRAIN_STDIN_READY__";

export function claudeCliInvocation(model?: string): { command: string; args: string[]; stdinReadyMarker?: string } {
  // `--max-turns 1` throttled real episode generation to a ~40% extractive
  // fallback (observed 2026-07-19): Claude Code is agentic by default, so on a
  // large pack the model sometimes spends its one turn on a tool call and then
  // has no turn left to answer, erroring `error_max_turns`. A generation call
  // should never be cut off, so give it headroom — the final `result` is still
  // the single JSON answer regardless of any intermediate turns.
  const cliArgs = ["-p", "--output-format", "json", "--max-turns", "8"];
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
  // WSL bridge: sandbox cwd inside WSL, login shell for PATH, prompt on stdin
  // only after the readiness marker (see WSL_STDIN_READY_MARKER above).
  return {
    command: "wsl.exe",
    args: [
      "-e",
      "bash",
      "-lc",
      `echo ${WSL_STDIN_READY_MARKER} >&2; mkdir -p ~/.wapp-brain-sandbox && cd ~/.wapp-brain-sandbox && claude ${cliArgs.join(" ")}`
    ],
    stdinReadyMarker: WSL_STDIN_READY_MARKER
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
  const { command, args, stdinReadyMarker } = claudeCliInvocation(model);
  const prompt = `${request.system}\n\n---\n\n${request.user}\n\nRespond with ONLY the JSON object described above — no prose, no markdown fences. Keep the response under ${request.maxOutputTokens} tokens.`;
  const output = await runChildProcess(command, args, prompt, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, stdinReadyMarker);
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
    throw classifyProviderFailure(
      envelope.api_error_status ?? null,
      new PublicError("BRAIN_CLI_ERROR", `The Claude CLI reported an error${status}: ${reason}`),
      reason
    );
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
  if (!codexSessionExists()) {
    throw new PublicError(
      "BRAIN_CODEX_NO_SESSION",
      "Codex has no local session; run `npm run brain:provider -- login-codex` in a terminal first. Refusing rather than starting an interactive login inside the server."
    );
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = await withTimeout(loadCodexClient(), timeoutMs, "BRAIN_CODEX_TIMEOUT", "The Codex client did not connect in time.");
  let response: { content?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    response = (await withTimeout(
      client.sendMessage(request.user, {
        model,
        instructions: `${request.system}\nRespond with ONLY the requested JSON object — no prose, no markdown fences.`,
        reasoning: { effort: request.effort ?? DEFAULT_CODEX_REASONING_EFFORT, summary: "auto" },
        text: { verbosity: "low" },
        store: false
      }),
      timeoutMs,
      "BRAIN_CODEX_TIMEOUT",
      `The Codex model did not answer within ${Math.round(timeoutMs / 1000)}s.`
    )) as { content?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  } catch (error) {
    // The client surfaces HTTP failures as `API Error <status>: <body>`. The
    // body is a provider diagnostic, never archive content, but it is redacted
    // and bounded on the way out regardless.
    const raw = error instanceof Error ? error.message : "";
    const status = /API Error (\d{3})/.exec(raw);
    throw classifyProviderFailure(
      status ? Number(status[1]) : null,
      error,
      redactForDisplay(raw).slice(0, 200)
    );
  }
  if (typeof response?.content !== "string") {
    throw new PublicError("BRAIN_CODEX_BAD_RESPONSE", "The Codex client returned no readable content.");
  }
  // Prefer the real usage object (surfaced on response.completed) when present;
  // otherwise estimate from characters and flag the row estimated — never zero.
  const reportedInput = Number(response.usage?.input_tokens);
  const reportedOutput = Number(response.usage?.output_tokens);
  const hasUsage = Number.isFinite(reportedInput) && Number.isFinite(reportedOutput) && reportedInput + reportedOutput > 0;
  const usage: BrainTokenUsage = hasUsage
    ? { inputTokens: reportedInput, outputTokens: reportedOutput, estimated: false }
    : {
        inputTokens: estimateTokens(request.system) + estimateTokens(request.user),
        outputTokens: estimateTokens(response.content),
        estimated: true
      };
  return { json: parseModelJson(response.content), usage };
}

// Hangs are the enemy of visible progress: every provider await gets a hard
// deadline so a stuck call becomes a reported failure, never a frozen run.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PublicError(code, message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface CodexClientLike {
  connect(): Promise<unknown>;
  sendMessage(prompt: string, options: Record<string, unknown>): Promise<unknown>;
}

// Indirect import defeats TypeScript's static resolution: the package is an
// optional sibling install, mirroring the memory subsystem's Codex loading.
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

// H7 guard (historical-backfill): each call gets its own stateless client, but
// CONNECT is serialized behind this in-process queue — two in-flight token
// refreshes racing the session file are the one shared-state hazard under the
// concurrent worker pool. The queue must survive a failed connect (a rejection
// never poisons later calls).
let codexConnectQueue: Promise<unknown> = Promise.resolve();

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
  const connectTurn = codexConnectQueue.then(() => client.connect());
  codexConnectQueue = connectTurn.catch(() => undefined);
  await connectTurn;
  return client;
}

// --- shared helpers ---

function runChildProcess(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
  stdinReadyMarker?: string
): Promise<{ stdout: string; code: number; stderrHint: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdinSent = false;
    const sendStdin = () => {
      if (stdinSent) {
        return;
      }
      stdinSent = true;
      child.stdin.write(stdin);
      child.stdin.end();
    };
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
      if (stdinReadyMarker && stderr.includes(stdinReadyMarker)) {
        sendStdin();
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
      const hint =
        stderr
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line !== stdinReadyMarker)[0]
          ?.slice(0, 160) ?? "";
      resolve({ stdout, code: code ?? -1, stderrHint: hint });
    });
    if (!stdinReadyMarker) {
      sendStdin();
    }
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
