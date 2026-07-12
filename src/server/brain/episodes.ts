// Episodic tier: turn a chat's unassimilated window into cited episodes.
// Evidence packs are visible-exchange messages segmented at silence gaps and
// size caps; generation is model-backed (strict JSON, citations validated
// against the pack, one retry) with an extractive fallback so coverage never
// blocks on a model. Commit is atomic (episode + claims + citations +
// watermark) and projects an Obsidian-friendly Markdown file.

import fs from "node:fs";
import path from "node:path";
import type { BrainClaimKind, BrainEpisodeRecord, MemoryEvidenceMessage } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { PublicError, publicErrorMessage } from "../privacy";
import { generateStructured, type BrainTokenUsage } from "./provider";

const SILENCE_GAP_MS = 90 * 60_000;
const MIN_SEGMENT_FOR_SPLIT = 10;

export interface BrainEvidencePack {
  chatSourceId: string;
  chatDisplayName: string | null;
  startAtMs: number;
  endAtMs: number;
  messages: MemoryEvidenceMessage[];
  participants: string[];
}

function isEvidenceMessage(message: MemoryEvidenceMessage): boolean {
  if (["system", "status", "reaction", "encrypted_update"].includes(message.messageType)) {
    return false;
  }
  return message.direction === "incoming" || message.direction === "outgoing" || Boolean(message.text?.trim());
}

// The archive owner's messages: outgoing direction, or the importer's "me"
// sender sentinel (which also materialized a contact literally named "Me" —
// never surface that as a person's name).
function isSelfMessage(message: MemoryEvidenceMessage): boolean {
  return message.direction === "outgoing" || message.senderSourceJid === "me";
}

function senderLabel(message: MemoryEvidenceMessage, ownerLabel: string): string {
  if (isSelfMessage(message)) {
    return `${ownerLabel} (me)`;
  }
  return message.senderDisplayName && message.senderDisplayName.trim().toLowerCase() !== "me"
    ? message.senderDisplayName
    : "Unknown";
}

// Segment a chat window into packs: silence-gap boundaries, greedily merged
// up to the evidence cap; oversized silent-free stretches split hard.
export async function buildEvidencePacks(
  repository: ArchiveRepository,
  options: { chatSourceId: string; startAtMs: number; endAtMs: number; maxMessages?: number }
): Promise<BrainEvidencePack[]> {
  const maxMessages = options.maxMessages ?? config.brain.maxEvidenceMessages;
  const evidence = (
    await repository.listMemoryEvidenceMessages({
      startAtMs: options.startAtMs,
      endAtMs: options.endAtMs,
      chatSourceIds: [options.chatSourceId],
      limit: 10_000
    })
  ).filter(isEvidenceMessage);
  if (evidence.length === 0) {
    return [];
  }
  const segments: MemoryEvidenceMessage[][] = [];
  let current: MemoryEvidenceMessage[] = [];
  let lastTs: number | null = null;
  for (const message of evidence) {
    const ts: number = message.timestampMs ?? lastTs ?? 0;
    const gap = lastTs != null && ts - lastTs >= SILENCE_GAP_MS;
    if (current.length >= maxMessages || (gap && current.length >= MIN_SEGMENT_FOR_SPLIT)) {
      segments.push(current);
      current = [];
    }
    current.push(message);
    lastTs = ts;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  // Greedy merge of adjacent small segments under the cap.
  const merged: MemoryEvidenceMessage[][] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length + segment.length <= maxMessages) {
      previous.push(...segment);
    } else {
      merged.push(segment);
    }
  }
  const ownerLabel = (await repository.getArchiveOwnerName()) ?? "the archive owner";
  return merged.map((messages) => ({
    chatSourceId: options.chatSourceId,
    chatDisplayName: messages[0]?.chatDisplayName ?? null,
    startAtMs: messages[0]?.timestampMs ?? options.startAtMs,
    endAtMs: messages[messages.length - 1]?.timestampMs ?? options.endAtMs,
    messages,
    participants: [...new Set(messages.map((message) => senderLabel(message, ownerLabel)).filter((label) => label !== "Unknown"))]
  }));
}

const EPISODE_SYSTEM = `You are the assimilation engine of a private, local WhatsApp archive ("second brain").
You turn one conversation window into a faithful episode digest. Only state what the messages support.
Prefer decisions, commitments, questions, events, and durable facts over chit-chat. Use participants' names.`;

interface ModelClaim {
  kind?: string;
  text?: string;
  cites?: string[];
}

interface ModelEpisode {
  summary?: string;
  claims?: ModelClaim[];
}

const CLAIM_KINDS: BrainClaimKind[] = ["fact", "decision", "commitment", "question", "event"];

function packPromptLines(pack: BrainEvidencePack, ownerLabel: string): { lines: string[]; keyByAlias: Map<string, string> } {
  const keyByAlias = new Map<string, string>();
  const lines = pack.messages.map((message, index) => {
    const alias = `m${index + 1}`;
    keyByAlias.set(alias, message.sourceMessageKey);
    const time = message.sentAt ? message.sentAt.slice(0, 16).replace("T", " ") : "unknown-time";
    const text = message.text?.trim() || `[${message.interpretation?.label ?? message.messageType}]`;
    return `${alias} | ${time} | ${senderLabel(message, ownerLabel)}: ${text}`;
  });
  return { lines, keyByAlias };
}

function validateModelEpisode(
  payload: ModelEpisode,
  keyByAlias: Map<string, string>
): { summary: string; claims: Array<{ kind: BrainClaimKind; text: string; citations: string[] }> } {
  const summary = payload.summary?.trim();
  if (!summary) {
    throw new PublicError("EPISODE_NO_SUMMARY", "The generated episode is missing a summary.");
  }
  const claims = (payload.claims ?? []).map((claim) => {
    const text = claim.text?.trim();
    if (!text) {
      throw new PublicError("EPISODE_EMPTY_CLAIM", "A generated claim has no text.");
    }
    const kind = CLAIM_KINDS.includes(claim.kind as BrainClaimKind) ? (claim.kind as BrainClaimKind) : "fact";
    const cites = claim.cites ?? [];
    if (cites.length === 0) {
      throw new PublicError("EPISODE_NO_CITATIONS", `Claim "${text.slice(0, 60)}" cites no messages.`);
    }
    const citations = cites.map((alias) => {
      const key = keyByAlias.get(alias.trim());
      if (!key) {
        throw new PublicError("EPISODE_UNKNOWN_CITATION", `Claim cites "${alias}", which is not in the evidence pack.`);
      }
      return key;
    });
    return { kind, text, citations };
  });
  if (claims.length === 0) {
    throw new PublicError("EPISODE_NO_CLAIMS", "The generated episode contains no cited claims.");
  }
  return { summary, claims };
}

// Mechanical fallback: verbatim-quote claims from the most substantial
// messages. Honest, citation-complete, and marked regenerable.
function extractiveEpisode(
  pack: BrainEvidencePack,
  ownerLabel: string
): {
  summary: string;
  claims: Array<{ kind: BrainClaimKind; text: string; citations: string[] }>;
} {
  const textMessages = pack.messages.filter((message) => message.text?.trim());
  const top = [...textMessages].sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0)).slice(0, 5);
  const first = pack.messages[0];
  const last = pack.messages[pack.messages.length - 1];
  const summary = `${pack.messages.length} messages${pack.participants.length ? ` between ${pack.participants.slice(0, 4).join(", ")}` : ""} from ${first?.sentAt?.slice(0, 10) ?? "?"} to ${last?.sentAt?.slice(0, 10) ?? "?"} (extractive placeholder — regenerate with a model for real synthesis).`;
  const claims = top.map((message) => ({
    kind: "fact" as BrainClaimKind,
    text: `${isSelfMessage(message) ? ownerLabel : message.senderDisplayName?.trim() || "Someone"} wrote: "${(message.text ?? "").slice(0, 200)}"`,
    citations: [message.sourceMessageKey]
  }));
  return { summary, claims: claims.length > 0 ? claims : [{ kind: "fact", text: "Window contained no quotable text.", citations: [pack.messages[0].sourceMessageKey] }] };
}

function episodeMarkdown(record: BrainEpisodeRecord): string {
  const lines = [
    "---",
    `episode: ${record.id}`,
    `chat: "${(record.chatDisplayName ?? record.chatSourceId).replace(/"/g, "'")}"`,
    `range: ${new Date(record.startAtMs).toISOString()} .. ${new Date(record.endAtMs).toISOString()}`,
    `generator: ${record.generator}${record.model ? ` (${record.model})` : ""}`,
    "tags: [wapp-brain, episode]",
    "---",
    "",
    `# ${record.chatDisplayName ?? record.chatSourceId} — ${new Date(record.startAtMs).toISOString().slice(0, 10)}`,
    "",
    record.summary,
    "",
    "## Claims",
    ""
  ];
  record.claims.forEach((claim, index) => {
    const cites = claim.citations.map((citation) => `[${citation.sourceMessageKey}]`).join(" ");
    lines.push(`${index + 1}. **${claim.kind}** — ${claim.text} ${cites} ^claim-${index + 1}`);
  });
  return lines.join("\n");
}

function projectEpisodeFile(record: BrainEpisodeRecord): void {
  const dir = path.join(config.brain.rootDir, "episodes");
  fs.mkdirSync(dir, { recursive: true });
  const slug = `${new Date(record.startAtMs).toISOString().slice(0, 10)}-${record.chatSourceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}-${record.id.slice(0, 8)}`;
  const filePath = path.join(dir, `${slug}.md`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, record.markdown, "utf8");
  fs.renameSync(tempPath, filePath);
}

// Remove the projected files for reset episodes (files are named …-<id8>.md).
export function deleteProjectedEpisodeFiles(episodeIds: string[]): number {
  const dir = path.join(config.brain.rootDir, "episodes");
  if (episodeIds.length === 0 || !fs.existsSync(dir)) {
    return 0;
  }
  const suffixes = new Set(episodeIds.map((id) => `-${id.slice(0, 8)}.md`));
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    for (const suffix of suffixes) {
      if (file.endsWith(suffix)) {
        fs.rmSync(path.join(dir, file), { force: true });
        removed += 1;
        break;
      }
    }
  }
  return removed;
}

// Full-reset cleanup: the episodes dir is a pure one-way projection of the DB,
// so after a full reset it must be empty. This removes EVERY projected file,
// including orphans whose DB episode was already gone — which the id-matched
// deletion above cannot reach.
export function clearAllProjectedEpisodeFiles(): number {
  const dir = path.join(config.brain.rootDir, "episodes");
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".md")) {
      fs.rmSync(path.join(dir, file), { force: true });
      removed += 1;
    }
  }
  return removed;
}

export interface EpisodeGenerationResult {
  episode: BrainEpisodeRecord;
  usage: BrainTokenUsage | null;
  fellBackToExtractive: boolean;
}

// Generate + commit one pack. Model mode validates citations against the pack
// and retries once with the validation error before falling back.
export async function generateEpisodeForPack(
  repository: ArchiveRepository,
  pack: BrainEvidencePack,
  options: { generator: "model" | "extractive"; model?: string | null; runId?: string | null }
): Promise<EpisodeGenerationResult> {
  let summaryAndClaims: ReturnType<typeof validateModelEpisode> | null = null;
  let usage: BrainTokenUsage | null = null;
  let generator: "model" | "extractive" = options.generator;
  let fellBack = false;
  const ownerName = await repository.getArchiveOwnerName();
  const ownerLabel = ownerName ?? "the archive owner";
  if (options.generator === "model") {
    const { lines, keyByAlias } = packPromptLines(pack, ownerLabel);
    const basePrompt = `Chat: ${pack.chatDisplayName ?? pack.chatSourceId}
Archive owner: ${ownerLabel}. Messages marked "(me)" are the owner's own words${ownerName ? `; when other people write "${ownerName}" they mean the owner` : ""}. In summaries and claims refer to the owner as ${ownerName ? `"${ownerName}"` : `"the owner"`} — never as "Me".
Messages (${pack.messages.length}), each prefixed with its citation alias:

${lines.join("\n")}

Return JSON exactly of this shape:
{"summary": "<=80 words describing what happened in this window", "claims": [{"kind": "fact|decision|commitment|question|event", "text": "one durable, self-contained statement", "cites": ["m3","m7"]}]}
Rules: 2-8 claims; every claim MUST cite at least one alias from the list; cite only aliases that truly support the claim; skip greetings and filler.`;
    let attemptError: string | null = null;
    for (let attempt = 0; attempt < 2 && !summaryAndClaims; attempt += 1) {
      try {
        const prompt = attemptError
          ? `${basePrompt}\n\nYour previous answer was rejected: ${attemptError}. Fix this and answer again.`
          : basePrompt;
        const result = await generateStructured({
          system: EPISODE_SYSTEM,
          user: prompt,
          maxOutputTokens: 1200,
          model: options.model ?? null
        });
        usage = result.usage;
        summaryAndClaims = validateModelEpisode(result.json as ModelEpisode, keyByAlias);
      } catch (error) {
        attemptError = publicErrorMessage(error);
        // Provider-unavailable classes should not burn a retry on the same
        // failure; fall through to extractive immediately.
        if (error instanceof PublicError && error.message.includes("provider")) {
          break;
        }
      }
    }
    if (!summaryAndClaims) {
      generator = "extractive";
      fellBack = true;
      console.warn(`[brain] episode generation fell back to extractive for a pack of ${pack.messages.length} messages: ${attemptError}`);
    }
  }
  if (!summaryAndClaims) {
    summaryAndClaims = extractiveEpisode(pack, ownerLabel);
  }
  const committed = await repository.commitBrainEpisode({
    chatSourceId: pack.chatSourceId,
    startAtMs: pack.startAtMs,
    endAtMs: pack.endAtMs,
    messageCount: pack.messages.length,
    participants: pack.participants,
    summary: summaryAndClaims.summary,
    markdown: "",
    generator,
    model: generator === "model" ? options.model ?? null : null,
    runId: options.runId ?? null,
    claims: summaryAndClaims.claims
  });
  const markdown = episodeMarkdown(committed);
  committed.markdown = markdown;
  await repository.updateBrainEpisodeMarkdown(committed.id, markdown);
  try {
    projectEpisodeFile(committed);
  } catch (error) {
    console.warn(`[brain] episode file projection failed: ${publicErrorMessage(error)}`);
  }
  return { episode: committed, usage, fellBackToExtractive: fellBack };
}
