// Episodic tier: turn a chat's unassimilated window into cited episodes.
// Evidence packs are visible-exchange messages segmented at silence gaps and
// size caps; generation is model-backed (strict JSON, citations validated
// against the pack, one retry) with an extractive fallback so coverage never
// blocks on a model. Commit is atomic (episode + claims + citations +
// watermark) and projects an Obsidian-friendly Markdown file.

import fs from "node:fs";
import path from "node:path";
import type { BrainClaimKind, BrainEpisodeRecord, MemoryEvidenceMessage, MemoryEvidenceReaction } from "../../shared/types";
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

// Deterministic short hash for JID-based fallback labels (no crypto needed —
// just a stable, collision-resistant-enough token per identity).
function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

// A stable, verbatim, substitutable number token for an unresolved participant.
// The FULL number is kept (never truncated) so late identity resolution can
// find-and-replace the exact token once a name binds. PN → "+digits", LID →
// "lid:digits", anything else → "participant-<shorthash>".
function numberLabelFromJid(jid: string | null | undefined): string {
  if (!jid || jid === "me") {
    return "participant-unknown";
  }
  const [user, server] = jid.split("@");
  const digits = (user?.split(":")[0] ?? "").replace(/\D/g, "");
  if (server === "lid") {
    return digits ? `lid:${digits}` : `participant-${shortHash(jid)}`;
  }
  return digits ? `+${digits}` : `participant-${shortHash(jid)}`;
}

// Base label for a non-self participant: a real display name when present,
// otherwise the number token. (The evidence query already resolves PN senders
// to "+digits" via displayPhoneFromJid, so this only reaches the number path
// for LID/other/null identities.)
function baseParticipantLabel(jid: string | null, displayName: string | null): string {
  const name = displayName?.trim();
  if (name && name.toLowerCase() !== "me") {
    return name;
  }
  return numberLabelFromJid(jid);
}

interface PackLabeler {
  sender: (message: MemoryEvidenceMessage) => string;
  reactor: (jid: string | null, displayName: string | null) => string;
}

// One labelling policy for a pack, governing both senders and reactors. Distinct
// sender identities that resolve to the SAME display name are disambiguated with
// a deterministic number-derived suffix (extended until unique) so the model can
// tell same-name participants apart and refer to each by exactly the label shown.
function buildPackLabeler(messages: MemoryEvidenceMessage[], ownerName: string): PackLabeler {
  const ownerLabel = `${ownerName} (me)`;
  // Distinct non-self sender identities and their base labels.
  const baseByJid = new Map<string, string>();
  const digitsByJid = new Map<string, string>();
  for (const message of messages) {
    const jid = message.senderSourceJid;
    if (isSelfMessage(message) || !jid || baseByJid.has(jid)) {
      continue;
    }
    baseByJid.set(jid, baseParticipantLabel(jid, message.senderDisplayName));
    digitsByJid.set(jid, ((jid.split("@")[0]?.split(":")[0] ?? "").replace(/\D/g, "")));
  }
  // Find base labels shared by more than one identity → collisions to resolve.
  const jidsByBase = new Map<string, string[]>();
  for (const [jid, base] of baseByJid) {
    jidsByBase.set(base, [...(jidsByBase.get(base) ?? []), jid]);
  }
  const labelByJid = new Map(baseByJid);
  for (const [base, jids] of jidsByBase) {
    if (jids.length < 2) {
      continue;
    }
    const maxLen = Math.max(2, ...jids.map((jid) => digitsByJid.get(jid)?.length ?? 0));
    let len = 2;
    while (len < maxLen) {
      const tails = jids.map((jid) => (digitsByJid.get(jid) ?? "").slice(-len));
      if (new Set(tails).size === jids.length) {
        break;
      }
      len += 1;
    }
    for (const jid of jids) {
      const digits = digitsByJid.get(jid) ?? "";
      const suffix = digits ? `…${digits.slice(-len)}` : shortHash(jid);
      labelByJid.set(jid, `${base} (${suffix})`);
    }
  }
  return {
    sender: (message) => {
      if (isSelfMessage(message)) {
        return ownerLabel;
      }
      const jid = message.senderSourceJid;
      return (jid && labelByJid.get(jid)) || baseParticipantLabel(jid, message.senderDisplayName);
    },
    reactor: (jid, displayName) => {
      if (jid === "me") {
        return ownerName;
      }
      return (jid && labelByJid.get(jid)) || baseParticipantLabel(jid, displayName);
    }
  };
}

// Segment a chat window into packs: silence-gap boundaries, greedily merged
// up to the evidence cap; oversized silent-free stretches split hard.
export async function buildEvidencePacks(
  repository: ArchiveRepository,
  options: { chatSourceId: string; startAtMs: number; endAtMs: number; afterId?: number; maxMessages?: number }
): Promise<BrainEvidencePack[]> {
  const maxMessages = options.maxMessages ?? config.brain.maxEvidenceMessages;
  // `startAtMs` is the inclusive cursor timestamp; `afterId` is its rowid half.
  // Selecting resumes strictly after the (timestamp, rowid) cursor so a new
  // message sharing the boundary timestamp is picked up, while the already-seen
  // boundary message (id <= afterId) is not re-opened. Coverage below the
  // boundary timestamp is filtered by the SQL lower bound.
  const afterId = options.afterId ?? 0;
  const evidence = (
    await repository.listMemoryEvidenceMessages({
      startAtMs: options.startAtMs,
      endAtMs: options.endAtMs,
      chatSourceIds: [options.chatSourceId],
      limit: 10_000
    })
  )
    .filter(isEvidenceMessage)
    .filter((message) => (message.timestampMs ?? 0) > options.startAtMs || message.messageId > afterId);
  if (evidence.length === 0) {
    return [];
  }
  // A hard time-span cap (independent of the scheduler) so a quiet chat's sparse
  // backlog produces week-bounded packs instead of one spanning months/years.
  const maxSpanMs = config.brain.maxEpisodeSpanMs;
  const segments: MemoryEvidenceMessage[][] = [];
  let current: MemoryEvidenceMessage[] = [];
  let lastTs: number | null = null;
  let segmentStartTs: number | null = null;
  for (const message of evidence) {
    const ts: number = message.timestampMs ?? lastTs ?? 0;
    const gap = lastTs != null && ts - lastTs >= SILENCE_GAP_MS;
    const overSpan = segmentStartTs != null && ts - segmentStartTs >= maxSpanMs;
    if (current.length >= maxMessages || overSpan || (gap && current.length >= MIN_SEGMENT_FOR_SPLIT)) {
      segments.push(current);
      current = [];
      segmentStartTs = null;
    }
    current.push(message);
    lastTs = ts;
    if (segmentStartTs == null) {
      segmentStartTs = ts;
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  // Greedy merge of adjacent small segments under the size cap AND the span cap.
  const merged: MemoryEvidenceMessage[][] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const previousStart = previous?.[0]?.timestampMs ?? null;
    const segmentEnd = segment[segment.length - 1]?.timestampMs ?? null;
    const mergedSpan = previousStart != null && segmentEnd != null ? segmentEnd - previousStart : 0;
    if (previous && previous.length + segment.length <= maxMessages && mergedSpan < maxSpanMs) {
      previous.push(...segment);
    } else {
      merged.push(segment);
    }
  }
  const ownerName = (await repository.getArchiveOwnerName()) ?? "the archive owner";
  return merged.map((messages) => {
    const labeler = buildPackLabeler(messages, ownerName);
    return {
      chatSourceId: options.chatSourceId,
      chatDisplayName: messages[0]?.chatDisplayName ?? null,
      startAtMs: messages[0]?.timestampMs ?? options.startAtMs,
      endAtMs: messages[messages.length - 1]?.timestampMs ?? options.endAtMs,
      messages,
      participants: [...new Set(messages.map((message) => labeler.sender(message)))]
    };
  });
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

const MAX_REACTIONS_PER_LINE = 8;

// Reactions render inline on their target line as non-citable annotations; they
// consume no alias and no budget line. A claim about an acknowledgment cites the
// target message's alias, never the reaction.
function renderReactions(reactions: MemoryEvidenceReaction[], labeler: PackLabeler): string {
  if (reactions.length === 0) {
    return "";
  }
  const shown = reactions.slice(0, MAX_REACTIONS_PER_LINE).map((reaction) => {
    const who = labeler.reactor(reaction.reactorJid, reaction.reactorDisplayName);
    // An unknown reactor (no identity at all) is noise — show the bare emoji.
    return who === "participant-unknown" ? `[${reaction.emoji}]` : `[${reaction.emoji} ${who}]`;
  });
  const extra = reactions.length - MAX_REACTIONS_PER_LINE;
  return ` ${shown.join(" ")}${extra > 0 ? ` [+${extra} more]` : ""}`;
}

function packPromptLines(
  pack: BrainEvidencePack,
  ownerName: string,
  quotedReferents: Map<string, { senderLabel: string; snippet: string }>
): { lines: string[]; keyByAlias: Map<string, string> } {
  const labeler = buildPackLabeler(pack.messages, ownerName);
  const keyByAlias = new Map<string, string>();
  // In-pack quoted-reply resolution: a message's quotedSourceMessageId matches
  // another pack message's sourceMessageId, and that message already has an alias.
  const inPackByQuotedId = new Map<string, { alias: string; sender: string; snippet: string }>();
  pack.messages.forEach((message, index) => {
    if (!inPackByQuotedId.has(message.sourceMessageId)) {
      inPackByQuotedId.set(message.sourceMessageId, {
        alias: `m${index + 1}`,
        sender: labeler.sender(message),
        snippet: (message.text ?? "").trim().slice(0, 80)
      });
    }
  });
  const lines = pack.messages.map((message, index) => {
    const alias = `m${index + 1}`;
    keyByAlias.set(alias, message.sourceMessageKey);
    const time = message.sentAt ? message.sentAt.slice(0, 16).replace("T", " ") : "unknown-time";
    const text = message.text?.trim() || `[${message.interpretation?.label ?? message.messageType}]`;
    const label = labeler.sender(message);
    const senderText = message.isForwarded ? `${label} (forwarded)` : label;
    const reactionsText = renderReactions(message.reactions, labeler);
    let referent = "";
    const quotedId = message.quotedSourceMessageId;
    if (quotedId) {
      const inPack = inPackByQuotedId.get(quotedId);
      if (inPack && inPack.alias !== alias) {
        referent = `\n     ↳ replying to ${inPack.alias} (${inPack.sender}): "${inPack.snippet}"`;
      } else {
        const out = quotedReferents.get(quotedId);
        referent = out
          ? `\n     ↳ replying to (${out.senderLabel}): "${out.snippet}"`
          : "\n     ↳ replying to an earlier message";
      }
    }
    return `${alias} | ${time} | ${senderText}: ${text}${reactionsText}${referent}`;
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
  ownerName: string
): {
  summary: string;
  claims: Array<{ kind: BrainClaimKind; text: string; citations: string[] }>;
} {
  const labeler = buildPackLabeler(pack.messages, ownerName);
  const textMessages = pack.messages.filter((message) => message.text?.trim());
  const top = [...textMessages].sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0)).slice(0, 5);
  const first = pack.messages[0];
  const last = pack.messages[pack.messages.length - 1];
  const summary = `${pack.messages.length} messages${pack.participants.length ? ` between ${pack.participants.slice(0, 4).join(", ")}` : ""} from ${first?.sentAt?.slice(0, 10) ?? "?"} to ${last?.sentAt?.slice(0, 10) ?? "?"} (extractive placeholder — regenerate with a model for real synthesis).`;
  const claims = top.map((message) => {
    // Extractive prose uses the clean owner name (the "(me)" suffix is a
    // prompt-only device for the model, not user-facing text).
    const who = isSelfMessage(message) ? ownerName : labeler.sender(message);
    const verb = message.isForwarded ? "shared" : "wrote";
    return {
      kind: "fact" as BrainClaimKind,
      text: `${who} ${verb}: "${(message.text ?? "").slice(0, 200)}"`,
      citations: [message.sourceMessageKey]
    };
  });
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
  let fallbackReason: string | null = null;
  const ownerName = await repository.getArchiveOwnerName();
  const ownerLabel = ownerName ?? "the archive owner";
  if (options.generator === "model") {
    // Resolve quoted-reply referents that are NOT already in the pack (in-pack
    // quotes are stitched by alias directly). Keyed by the surrogate message id
    // that quoted_source_message_id holds.
    const inPackIds = new Set(pack.messages.map((message) => message.sourceMessageId));
    const outOfPackQuotedIds = pack.messages
      .map((message) => message.quotedSourceMessageId)
      .filter((id): id is string => Boolean(id) && !inPackIds.has(id as string));
    const quotedReferents = await repository.resolveQuotedReferents(pack.chatSourceId, outOfPackQuotedIds);
    const { lines, keyByAlias } = packPromptLines(pack, ownerLabel, quotedReferents);
    const basePrompt = `Chat: ${pack.chatDisplayName ?? pack.chatSourceId}
Archive owner: ${ownerLabel}. Messages marked "(me)" are the owner's own words${ownerName ? `; when other people write "${ownerName}" they mean the owner` : ""}. In summaries and claims refer to the owner as ${ownerName ? `"${ownerName}"` : `"the owner"`} — never as "Me".
Annotations on an evidence line: "[emoji Name]" is a reaction someone left on that message (an acknowledgment — it belongs to that message, cite the message's alias, not the reaction); "↳ replying to …" shows the message this one answers; "(forwarded)" after a name means the sender shared/forwarded that content rather than authored it.
Messages (${pack.messages.length}), each prefixed with its citation alias:

${lines.join("\n")}

Return JSON exactly of this shape:
{"summary": "<=80 words describing what happened in this window", "claims": [{"kind": "fact|decision|commitment|question|event", "text": "one durable, self-contained statement", "cites": ["m3","m7"]}]}
Rules: 2-8 claims; every claim MUST cite at least one alias from the list; cite only aliases that truly support the claim; skip greetings and filler. Attribute "(forwarded)" content as shared/forwarded, never as something the sender said. Refer to any participant shown as a number or a "lid:"/"participant-" token by exactly that token, verbatim. Use participant names/labels exactly as shown (a name with a "(…digits)" suffix distinguishes two people who share a name — keep the suffix).`;
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
      fallbackReason = attemptError;
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
    fallbackReason: fellBack ? fallbackReason : null,
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
