// Deterministic vault projection (semantic-rollups): pages and the overview
// are pure functions of stored state, rendered by brain/rollups.ts and written
// under config.brain.rootDir beside the episode files. Re-running is
// idempotent (byte-stable for unchanged state); zero model calls ever.

import fs from "node:fs";
import path from "node:path";
import type { BrainDocKind } from "../../shared/types";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { publicErrorMessage } from "../privacy";
import { renderDocMarkdown, renderOverviewMarkdown } from "./rollups";
import { docFileBase, docFileMatchesSlug, episodeFileBase } from "./vaultNames";

const DOC_DIRS: Record<BrainDocKind, string> = {
  entity: "entities",
  topic: "topics",
  chat: "chats"
};

export function docFilePath(kind: BrainDocKind, slug: string, title: string): string {
  return path.join(config.brain.rootDir, DOC_DIRS[kind], `${docFileBase(title, slug)}.md`);
}

// The readable half of a file name changes when a contact or chat is renamed,
// so writing the new name is only half the job — the file under the OLD name
// must go, or the vault shows the same page twice. The stable id in every name
// makes "which files are this doc's" a deterministic question.
function removeStaleVariants(dir: string, keepFileName: string, belongsHere: (fileName: string) => boolean): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    if (file !== keepFileName && belongsHere(file)) {
      try {
        fs.unlinkSync(path.join(dir, file));
        removed += 1;
      } catch (error) {
        console.warn(`[brain] could not remove stale file ${path.join(dir, file)}: ${publicErrorMessage(error)}`);
      }
    }
  }
  return removed;
}

// Write-if-changed keeps mtimes stable for unchanged docs (and makes the
// rebuild's idempotence observable as zero rewrites).
function writeFileStable(filePath: string, content: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
      return false;
    }
  } catch {
    // Unreadable existing file: fall through to the write.
  }
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

// Clean up a doc that no longer projects (unrolled): it isn't in the
// projectable set, so its title — and therefore its file name — is unknown.
// The slug in the name is the key, so this is a search rather than a path.
function removeDocFilesById(docId: string): number {
  const separator = docId.indexOf(":");
  if (separator < 0) {
    return 0;
  }
  const kind = docId.slice(0, separator);
  const slug = docId.slice(separator + 1);
  if (kind !== "entity" && kind !== "topic" && kind !== "chat") {
    return 0;
  }
  return removeStaleVariants(path.join(config.brain.rootDir, DOC_DIRS[kind]), "", (file) => docFileMatchesSlug(file, slug));
}

// Project current docs (optionally a subset) to their vault files. A requested
// doc with nothing to project (unrolled to no current revision) has its stale
// file removed — the vault must never show a page the database no longer has.
export async function projectBrainDocs(
  repository: ArchiveRepository,
  options?: { docIds?: string[] | null }
): Promise<{ written: number; unchanged: number; removed: number }> {
  const wanted = options?.docIds && options.docIds.length > 0 ? new Set(options.docIds) : null;
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  const projected = new Set<string>();
  for (const { context, sections } of await repository.listBrainDocsForProjection()) {
    if (wanted && !wanted.has(context.docId)) {
      continue;
    }
    projected.add(context.docId);
    const markdown = renderDocMarkdown(context, sections);
    const filePath = docFilePath(context.kind, context.slug, context.title);
    if (writeFileStable(filePath, markdown)) {
      written += 1;
    } else {
      unchanged += 1;
    }
    // A rename leaves the same doc under its old name; drop it.
    removed += removeStaleVariants(path.dirname(filePath), path.basename(filePath), (file) =>
      docFileMatchesSlug(file, context.slug)
    );
  }
  for (const docId of wanted ?? []) {
    if (!projected.has(docId)) {
      removed += removeDocFilesById(docId);
    }
  }
  return { written, unchanged, removed };
}

// Reconcile ONE chat's episode files after its mute state changed. A mute
// affects a single chat, so rebuilding the whole 9.4k-file vault for it is both
// wasteful and — because each file is a synchronous read+write — the thing that
// pins the event loop and makes every other request hang.
//
// Yields every 50 files rather than every 500-item batch: a batch of 500
// synchronous Windows file writes is itself a multi-second block.
export async function reprojectChatEpisodes(
  repository: ArchiveRepository,
  chatSourceId: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ written: number; removed: number }> {
  const { projectEpisodeFile } = await import("./episodes");
  // What SHOULD exist for this chat now (the mute predicate already applied).
  const projectable = await repository.listBrainEpisodeProjections({ chatSourceId, limit: 100_000 });
  const keep = new Set(projectable.map((episode) => `${episodeFileBase(episode)}.md`));
  let written = 0;
  let removed = 0;
  const total = projectable.length;

  for (let index = 0; index < projectable.length; index += 1) {
    const episode = projectable[index]!;
    const filePath = path.join(config.brain.rootDir, "episodes", `${episodeFileBase(episode)}.md`);
    let unchanged = false;
    if (fs.existsSync(filePath)) {
      try {
        unchanged = fs.readFileSync(filePath, "utf8") === episode.markdown;
      } catch {
        // Unreadable: fall through and rewrite.
      }
    }
    if (!unchanged) {
      projectEpisodeFile({ ...episode } as Parameters<typeof projectEpisodeFile>[0]);
      written += 1;
    }
    if (index % 50 === 49) {
      onProgress?.(index + 1, total);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // What this chat WOULD project if it were not muted — the exact set of files
  // a mute must remove. Derived from the same naming function as the write, so
  // it stays correct across renames, and read through the lean projection query
  // rather than the full episode hydrator (which issues per-episode queries for
  // claims, citations, entities and topics — thousands of round-trips for a
  // chat this size, and most of the cost of the first version).
  const hidden = await repository.listBrainEpisodeProjections({ chatSourceId, onlyMuted: true, limit: 100_000 });
  for (const episode of hidden) {
    const fileName = `${episodeFileBase(episode)}.md`;
    if (keep.has(fileName)) continue;
    const filePath = path.join(config.brain.rootDir, "episodes", fileName);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    }
  }
  return { written, removed };
}

// Re-project every current episode from its stored markdown. The vault is a
// pure projection, so a wiped episodes/ directory is always fully recoverable
// from the database — no model calls, no re-derivation. Batched so a 9k-episode
// archive never materializes at once.
export async function projectBrainEpisodes(
  repository: ArchiveRepository,
  onProgress?: (written: number) => void
): Promise<{ written: number; unchanged: number; expectedFiles: Set<string> }> {
  const { projectEpisodeFile } = await import("./episodes");
  const BATCH = 500;
  let written = 0;
  let unchanged = 0;
  // Collected so the caller can sweep whatever ISN'T here — the migration path
  // for episodes renamed by a new convention or a chat rename.
  const expectedFiles = new Set<string>();
  for (let offset = 0; ; offset += BATCH) {
    const batch = await repository.listBrainEpisodeProjections({ limit: BATCH, offset });
    if (batch.length === 0) {
      break;
    }
    for (const episode of batch) {
      const fileName = `${episodeFileBase(episode)}.md`;
      expectedFiles.add(fileName);
      const filePath = path.join(config.brain.rootDir, "episodes", fileName);
      if (fs.existsSync(filePath)) {
        try {
          if (fs.readFileSync(filePath, "utf8") === episode.markdown) {
            unchanged += 1;
            continue;
          }
        } catch {
          // Unreadable: fall through and rewrite.
        }
      }
      projectEpisodeFile({ ...episode, markdown: episode.markdown } as Parameters<typeof projectEpisodeFile>[0]);
      written += 1;
    }
    onProgress?.(written);
    // Yield so a full rebuild never blocks live sync or HTTP.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { written, unchanged, expectedFiles };
}

// The deterministic overview file (R11): derivable, fresh after every run,
// cannot rot, costs nothing.
export async function projectBrainOverview(repository: ArchiveRepository, providerLine?: string | null): Promise<void> {
  const data = await repository.getBrainOverviewData();
  writeFileStable(path.join(config.brain.rootDir, "overview.md"), renderOverviewMarkdown({ ...data, providerLine: providerLine ?? data.providerLine }));
}

// Full rebuild (`brain project --rebuild`): re-render every projectable doc +
// the overview, and sweep orphaned page files (docs deleted by a full reset).
// Idempotent and byte-stable — a second run writes nothing.
export async function rebuildBrainProjection(
  repository: ArchiveRepository,
  options?: { includeEpisodes?: boolean; includeOverview?: boolean; onProgress?: (written: number) => void }
): Promise<{ written: number; unchanged: number; removed: number; episodesWritten: number }> {
  // Episodes are part of the vault too — a rebuild must be able to restore
  // them, not just pages (they were the surface a wiped episodes/ dir lost).
  const episodes =
    options?.includeEpisodes === false
      ? { written: 0, unchanged: 0, expectedFiles: null }
      : await projectBrainEpisodes(repository, options?.onProgress);
  const projectable = await repository.listBrainDocsForProjection();
  const keep = new Set(projectable.map(({ context }) => docFilePath(context.kind, context.slug, context.title)));
  let removed = 0;
  const sweepDirs = [...Object.values(DOC_DIRS)];
  // Episodes are swept only when they were re-projected in this pass — the
  // expected set is the authority, and without it every episode file would
  // look orphaned. This is also the migration: files under a superseded naming
  // convention are simply not in the set.
  const episodeKeep = episodes.expectedFiles;
  if (episodeKeep) {
    sweepDirs.push("episodes");
  }
  for (const dir of sweepDirs) {
    const abs = path.join(config.brain.rootDir, dir);
    if (!fs.existsSync(abs)) {
      continue;
    }
    for (const file of fs.readdirSync(abs)) {
      const filePath = path.join(abs, file);
      const orphaned = dir === "episodes" ? !episodeKeep!.has(file) : !keep.has(filePath);
      if (file.endsWith(".md") && orphaned) {
        try {
          fs.unlinkSync(filePath);
          removed += 1;
        } catch (error) {
          console.warn(`[brain] projection cleanup failed for ${filePath}: ${publicErrorMessage(error)}`);
        }
      }
    }
  }
  const result = await projectBrainDocs(repository);
  // The overview is a whole-archive digest whose inputs (coverage, lifecycle
  // counts) are the most expensive reads in the app — several seconds on the
  // real archive. It is deterministic and refreshed after every run, so a mute
  // change skips it rather than making the user wait for a file they did not
  // ask about.
  if (options?.includeOverview !== false) {
    await projectBrainOverview(repository);
  }
  return {
    written: result.written,
    unchanged: result.unchanged,
    removed: removed + result.removed,
    episodesWritten: episodes.written
  };
}
