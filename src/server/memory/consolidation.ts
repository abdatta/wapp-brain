import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import type {
  MemoryCitationRecord,
  MemoryConsolidationRequest,
  MemoryConsolidationResult,
  MemoryEvidenceMessage,
  MemoryPageRevisionRecord,
  MemoryQueryEvidence,
  MemoryQueryResult,
  MemorySourceWindowRecord,
  MemoryValidationIssue
} from "../../shared/types";
import { getMemoryProviderStatus } from "./provider";

const MEMORY_LOCK_TTL_MS = 30 * 60_000;

export async function runMemoryConsolidation(
  repository: ArchiveRepository,
  request: MemoryConsolidationRequest = {}
): Promise<MemoryConsolidationResult> {
  const kind = request.kind ?? "rem";
  const bounds = await resolveBounds(repository, request);
  const runId = await repository.startMemoryRun({
    kind,
    sourceStartAtMs: bounds.startAtMs,
    sourceEndAtMs: bounds.endAtMs,
    sourceSummary: {
      dryRun: Boolean(request.dryRun),
      force: Boolean(request.force),
      chatSourceIds: request.chatSourceIds ?? []
    }
  });
  const locked = await repository.tryAcquireMemoryLock(runId, MEMORY_LOCK_TTL_MS);
  if (!locked) {
    await repository.failMemoryRun(runId, "blocked", "Another memory consolidation job is already running.");
    return blockedResult(repository, runId, "Another memory consolidation job is already running.");
  }

  try {
    const evidence = await repository.listMemoryEvidenceMessages({
      startAtMs: bounds.startAtMs,
      endAtMs: bounds.endAtMs,
      chatSourceIds: request.chatSourceIds,
      limit: config.memory.maxEvidenceMessages
    });
    const sourceHash = hashWindow(bounds.startAtMs, bounds.endAtMs, request.chatSourceIds ?? [], evidence);
    const alreadyCommitted = request.force ? null : await repository.getCommittedMemoryWindow(sourceHash);
    if (alreadyCommitted) {
      await repository.completeMemoryRun(runId, { pages: 0, citations: 0, messages: alreadyCommitted.messageCount, warnings: 0 });
      return {
        ok: true,
        run: (await repository.getMemoryRun(runId))!,
        window: alreadyCommitted,
        pages: [],
        issues: [],
        dryRun: Boolean(request.dryRun)
      };
    }

    const window = await repository.createMemorySourceWindow({
      runId,
      status: "open",
      startAtMs: bounds.startAtMs,
      endAtMs: bounds.endAtMs,
      chatSourceIds: request.chatSourceIds ?? [],
      messageCount: evidence.length,
      sourceHash,
      committedAt: null
    });
    const pack = {
      id: randomUUID(),
      runId,
      windowId: window.id,
      status: "prepared" as const,
      sequence: 1,
      messageCount: evidence.length,
      citationLabels: evidence.map((message) => message.citationLabel),
      createdAt: new Date().toISOString()
    };
    await repository.recordMemoryEvidencePack(pack);

    if (request.dryRun) {
      const previewPath = await writeDryRunPreview(runId, window, evidence);
      await repository.completeMemoryRun(runId, { pages: 0, citations: 0, messages: evidence.length, warnings: 0 });
      return {
        ok: true,
        run: (await repository.getMemoryRun(runId))!,
        window,
        pages: [],
        issues: [],
        dryRun: true,
        previewPath
      };
    }

    // Pages are extractive-only: model-backed synthesis lives in the brain tier.
    const pages = generateExtractivePages(runId, window, evidence);
    const issues = pages.flatMap((page) => validatePage(page.revision, page.citations, evidence));
    if (issues.some((issue) => issue.severity === "error")) {
      await repository.recordMemoryValidationIssues(issues);
      await repository.failMemoryRun(runId, "blocked", "Generated memory failed citation validation.", issues.length);
      return {
        ok: false,
        run: (await repository.getMemoryRun(runId))!,
        window,
        pages: [],
        issues,
        dryRun: false
      };
    }

    let citationCount = 0;
    for (const page of pages) {
      await writePageArtifacts(page.revision, page.citations);
      await repository.commitMemoryPageRevision(page.revision, page.citations);
      citationCount += page.citations.length;
    }
    await repository.commitMemorySourceWindow(window.id);
    await repository.recordMemoryValidationIssues(issues);
    await repository.markStaleMemoryForMissingMessages();
    await repository.completeMemoryRun(runId, { pages: pages.length, citations: citationCount, messages: evidence.length, warnings: issues.length });
    return {
      ok: true,
      run: (await repository.getMemoryRun(runId))!,
      window: { ...window, status: "committed", committedAt: new Date().toISOString() },
      pages: pages.map((page) => page.revision),
      issues,
      dryRun: false
    };
  } catch (error) {
    await repository.failMemoryRun(runId, "failed", publicMessage(error));
    throw error;
  } finally {
    await repository.releaseMemoryLock(runId);
  }
}

export async function queryMemory(repository: ArchiveRepository, query: string): Promise<MemoryQueryResult> {
  const normalized = query.trim();
  const pages = await repository.listMemoryPageRevisions({ query: normalized, limit: 8 });
  const citationsByRevision = new Map<string, MemoryCitationRecord[]>();
  for (const page of pages) {
    citationsByRevision.set(page.id, await repository.listMemoryCitations(page.id));
  }
  const latestCommitted = await repository.getLatestCommittedMemoryEndAtMs();
  const shortTermMessages = await repository.listMemoryEvidenceMessages({
    startAtMs: latestCommitted == null ? startOfTodayMs() : latestCommitted + 1,
    endAtMs: null,
    limit: config.memory.maxQueryMessages
  });
  const matchingShortTerm = filterMessagesByQuery(shortTermMessages, normalized).slice(0, 8);
  const longTermEvidence: MemoryQueryEvidence[] = pages.map((page) => ({
    layer: "long_term",
    title: page.title,
    snippet: page.summary,
    pageId: page.pageId,
    revisionId: page.id,
    citation: citationsByRevision.get(page.id)?.[0] ?? null,
    message: null
  }));
  const shortTermEvidence: MemoryQueryEvidence[] = matchingShortTerm.map((message) => ({
    layer: "short_term",
    title: message.chatDisplayName ?? message.sourceChatId,
    snippet: message.text ?? message.messageType,
    pageId: null,
    revisionId: null,
    citation: citationFromMessage("short-term", message),
    message
  }));
  const pageCitations = [...citationsByRevision.values()].flat();
  const citations = [...pageCitations, ...shortTermEvidence.map((item) => item.citation).filter((citation): citation is MemoryCitationRecord => Boolean(citation))];
  const evidence = [...longTermEvidence, ...shortTermEvidence];
  const answer = evidence.length
    ? [
        "Local retrieval result. Remote answer synthesis is disabled unless you explicitly enable a provider.",
        ...evidence.slice(0, 8).map((item, index) => `${index + 1}. [${item.layer}] ${item.title}: ${item.snippet}`)
      ].join("\n")
    : "The archive does not contain enough cited memory or short-term evidence for that query.";
  return {
    query: normalized,
    answer,
    remoteSynthesisUsed: false,
    evidence,
    citations
  };
}

export async function resolveMemoryCitation(repository: ArchiveRepository, citationLabelOrMessageKey: string) {
  const citation = await repository.resolveMemoryCitation(citationLabelOrMessageKey);
  if (!citation?.messageId) {
    return { ok: false, stale: true, citation, message: null, nearbyMessages: [] };
  }
  const nearbyMessages = await repository.listNearbyMemoryMessages(citation.messageId, 4);
  const message = nearbyMessages.find((candidate) => candidate.messageId === citation.messageId) ?? null;
  return {
    ok: Boolean(message),
    stale: !message,
    citation,
    message,
    nearbyMessages
  };
}

export async function validateMemoryStore(repository: ArchiveRepository) {
  const staleCount = await repository.markStaleMemoryForMissingMessages();
  const status = await repository.getMemoryStatus(await getMemoryProviderStatus());
  return { ok: staleCount === 0, staleCount, status };
}

async function resolveBounds(repository: ArchiveRepository, request: MemoryConsolidationRequest): Promise<{ startAtMs: number | null; endAtMs: number | null }> {
  const latestCommitted = await repository.getLatestCommittedMemoryEndAtMs();
  const defaultEnd = endOfPreviousLocalDayMs();
  return {
    startAtMs: request.startAtMs ?? (latestCommitted == null ? null : latestCommitted + 1),
    endAtMs: request.endAtMs ?? defaultEnd
  };
}

function generateExtractivePages(runId: string, window: MemorySourceWindowRecord, evidence: MemoryEvidenceMessage[]) {
  const byChat = new Map<string, MemoryEvidenceMessage[]>();
  for (const message of evidence) {
    const messages = byChat.get(message.sourceChatId) ?? [];
    messages.push(message);
    byChat.set(message.sourceChatId, messages);
  }
  return [...byChat].map(([chatSourceId, messages]) => pageFromMessages(runId, window, chatSourceId, messages));
}

function pageFromMessages(runId: string, window: MemorySourceWindowRecord, chatSourceId: string, messages: MemoryEvidenceMessage[]) {
  const title = messages[0]?.chatDisplayName || chatSourceId;
  const pageId = `chat-${slug(chatSourceId)}`;
  const revisionId = randomUUID();
  const relativePath = path.join("pages", "chats", `${slug(title)}-${slug(chatSourceId).slice(0, 16)}.md`);
  const citations = messages.map((message, index) => ({
    ...citationFromMessage(`claim-${index + 1}`, message),
    revisionId
  }));
  const summary = `${messages.length} cited WhatsApp messages consolidated for ${title}.`;
  const markdown = renderMarkdownPage({
    pageId,
    revisionId,
    title,
    chatSourceId,
    window,
    messages,
    summary
  });
  const revision: MemoryPageRevisionRecord = {
    id: revisionId,
    pageId,
    runId,
    windowId: window.id,
    title,
    path: relativePath.replace(/\\/g, "/"),
    summary,
    markdown,
    status: "current",
    sourceStartAtMs: window.startAtMs,
    sourceEndAtMs: window.endAtMs,
    citationCount: citations.length,
    createdAt: new Date().toISOString(),
    metadata: {
      obsidianCompatible: true,
      tags: ["wapp-brain", "second-brain", "whatsapp-memory"],
      chatSourceId
    }
  };
  return { revision, citations };
}

function renderMarkdownPage(input: {
  pageId: string;
  revisionId: string;
  title: string;
  chatSourceId: string;
  window: MemorySourceWindowRecord;
  messages: MemoryEvidenceMessage[];
  summary: string;
}): string {
  const frontMatter = [
    "---",
    `id: ${input.pageId}`,
    `revision_id: ${input.revisionId}`,
    "type: whatsapp-chat-memory",
    `title: ${yamlString(input.title)}`,
    `chat_source_id: ${yamlString(input.chatSourceId)}`,
    `source_start_at_ms: ${input.window.startAtMs ?? ""}`,
    `source_end_at_ms: ${input.window.endAtMs ?? ""}`,
    "tags:",
    "  - wapp-brain",
    "  - second-brain",
    "  - whatsapp-memory",
    "aliases:",
    `  - ${yamlString(input.title)}`,
    "---"
  ].join("\n");
  const bullets = input.messages
    .map((message, index) => {
      const who = message.senderDisplayName ?? message.senderSourceJid ?? "Unknown sender";
      const when = message.sentAt ?? "undated";
      const text = message.text ?? `[${message.messageType}]`;
      return `- ${text} ^claim-${index + 1}\n  - Source: ${who}, ${when}, citation ${message.citationLabel}, message ${message.sourceMessageKey}`;
    })
    .join("\n");
  return `${frontMatter}\n\n# ${input.title}\n\n${input.summary}\n\n## Timeline\n\n${bullets || "- No source messages in this window."}\n`;
}

function validatePage(
  revision: MemoryPageRevisionRecord,
  citations: MemoryCitationRecord[],
  evidence: MemoryEvidenceMessage[]
): MemoryValidationIssue[] {
  const labels = new Set(evidence.map((message) => message.citationLabel));
  const issues: MemoryValidationIssue[] = [];
  if (!citations.length) {
    issues.push(issueFor(revision.runId, "NO_CITATIONS", `Memory page ${revision.pageId} has no citations.`, revision.pageId));
  }
  for (const citation of citations) {
    if (!labels.has(citation.citationLabel)) {
      issues.push(issueFor(revision.runId, "UNKNOWN_CITATION", `Unknown citation label ${citation.citationLabel}.`, revision.pageId));
    }
  }
  if (!revision.markdown.includes("---") || !revision.markdown.includes("tags:")) {
    issues.push(issueFor(revision.runId, "MALFORMED_MARKDOWN", `Memory page ${revision.pageId} is missing Obsidian-friendly front matter.`, revision.pageId));
  }
  return issues;
}

function citationFromMessage(claimId: string, message: MemoryEvidenceMessage): MemoryCitationRecord {
  return {
    revisionId: "",
    claimId,
    citationLabel: message.citationLabel,
    messageId: message.messageId,
    sourceMessageKey: message.sourceMessageKey,
    sourceMessageId: message.sourceMessageId,
    sourceChatId: message.sourceChatId,
    senderSourceJid: message.senderSourceJid,
    timestampMs: message.timestampMs
  };
}

function issueFor(runId: string, code: string, message: string, pageId?: string | null): MemoryValidationIssue {
  return { runId, pageId: pageId ?? null, packId: null, severity: "error", code, message };
}

async function writePageArtifacts(revision: MemoryPageRevisionRecord, citations: MemoryCitationRecord[]): Promise<void> {
  const pagePath = path.join(config.memory.rootDir, revision.path);
  await atomicWrite(pagePath, revision.markdown);
  const sidecarPath = path.join(config.memory.citationsDir, `${revision.id}.json`);
  await atomicWrite(sidecarPath, `${JSON.stringify({ revision, citations }, null, 2)}\n`);
}

async function writeDryRunPreview(runId: string, window: MemorySourceWindowRecord, evidence: MemoryEvidenceMessage[]): Promise<string> {
  const previewPath = path.join(config.memory.runsDir, `${runId}-evidence-preview.json`);
  await atomicWrite(previewPath, `${JSON.stringify({ warning: "Contains WhatsApp-derived message evidence.", window, evidence }, null, 2)}\n`);
  return previewPath;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

function hashWindow(startAtMs: number | null, endAtMs: number | null, chatSourceIds: string[], evidence: MemoryEvidenceMessage[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startAtMs,
        endAtMs,
        chatSourceIds: [...chatSourceIds].sort(),
        count: evidence.length,
        first: evidence[0]?.sourceMessageKey ?? null,
        last: evidence.at(-1)?.sourceMessageKey ?? null
      })
    )
    .digest("hex");
}

function filterMessagesByQuery(messages: MemoryEvidenceMessage[], query: string): MemoryEvidenceMessage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return messages.slice(0, 8);
  }
  return messages.filter((message) => {
    const haystack = [message.text, message.chatDisplayName, message.senderDisplayName].filter(Boolean).join(" ").toLowerCase();
    return words.some((word) => haystack.includes(word));
  });
}

function endOfPreviousLocalDayMs(): number {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), config.memory.defaultCutoffHour, 0, 0, 0);
  return cutoff.getTime() - 1;
}

function startOfTodayMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "memory";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Memory operation failed.";
}

async function blockedResult(repository: ArchiveRepository, runId: string, message: string): Promise<MemoryConsolidationResult> {
  return {
    ok: false,
    run: (await repository.getMemoryRun(runId))!,
    window: null,
    pages: [],
    issues: [issueFor(runId, "JOB_LOCKED", message)],
    dryRun: false
  };
}
