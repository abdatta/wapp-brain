// Brain eval harness (design E1/E2/E9): golden-set retrieval recall measured
// through the REAL search path, persisted as comparable runs, with a
// machine-readable gate verdict against a baseline. Zero model calls by
// construction — nothing in this module can reach the provider seam.
//
// The golden set is user-authored ground truth living OUTSIDE git (real
// queries quote real archive content; the fixture policy forbids committing
// that): <WAPP_WORK_DIR>/eval/golden-queries.json, self-versioned, with a
// content hash stamped into every run so results are comparable only within
// the same golden content.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { ArchiveRepository } from "../db/repository";
import { PublicError } from "../privacy";
import type {
  BrainEvalClassStat,
  BrainEvalGateRegression,
  BrainEvalGateVerdict,
  BrainEvalQueryResult,
  BrainEvalRunRecord,
  BrainGoldenQuery,
  BrainGoldenSet,
  BrainGoldenSetInfo
} from "../../shared/types";

export const BRAIN_EVAL_K_VALUES = [5, 10, 20];
export const BRAIN_EVAL_TARGET_ARCHIVE_SEARCH = "archive-search";
// The canonical five; the vocabulary is open — new classes are data, not schema.
export const BRAIN_EVAL_CANONICAL_CLASSES = ["paraphrase", "person", "commitment", "temporal", "code-mixed"];

export function goldenSetPath(): string {
  return path.join(config.workDir, "eval", "golden-queries.json");
}

// Is the local app server answering? Connection refused (server down) means a
// CLI may safely open the database itself; anything answering means delegate
// over HTTP instead — the single writer stays inside the server process.
export async function localServerListening(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/search/status`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const SCAFFOLD_README =
  "Golden retrieval queries for the brain eval harness. Each query carries a stable id, a class " +
  `(canonical: ${BRAIN_EVAL_CANONICAL_CLASSES.join(" / ")}; new classes are fine), the query text as you would type it into search, ` +
  "and expect: the source message keys (wa|<chatSourceId>|<sourceMessageId>) the search should surface. " +
  "Find a message's key via the search UI or the messages table. Bump `version` when you edit; runs also record a content hash. " +
  "This file quotes your real archive — it stays out of git by design. Include this eval/ directory in whatever backup covers archive.sqlite.";

export function scaffoldGoldenSet(filePath = goldenSetPath()): BrainGoldenSetInfo {
  if (fs.existsSync(filePath)) {
    throw new PublicError("BRAIN_EVAL_GOLDEN_EXISTS", "A golden set already exists at that path — edit it instead of scaffolding over it.");
  }
  const scaffold: BrainGoldenSet = {
    version: 1,
    readme: SCAFFOLD_README,
    queries: [
      {
        id: "example-1",
        class: "paraphrase",
        query: "replace me — a real query about your archive",
        expect: ["wa|<chatSourceId>|<sourceMessageId>"],
        note: "Replace this example entry with real queries, then run the eval again."
      }
    ]
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8");
  return goldenInfoFor(filePath, scaffold, fs.readFileSync(filePath));
}

function goldenInfoFor(filePath: string, set: BrainGoldenSet, raw: Buffer): BrainGoldenSetInfo {
  return {
    path: filePath,
    version: set.version,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    queryCount: set.queries.length,
    classes: [...new Set(set.queries.map((query) => query.class))].sort()
  };
}

export function goldenSetExists(filePath = goldenSetPath()): boolean {
  return fs.existsSync(filePath);
}

// Load + validate the golden set. Placeholder scaffold entries (unreplaced
// examples) are rejected the same way an empty set is: measuring nothing must
// never read as a measurement.
export function loadGoldenSet(filePath = goldenSetPath()): { set: BrainGoldenSet; info: BrainGoldenSetInfo } {
  if (!fs.existsSync(filePath)) {
    throw new PublicError(
      "BRAIN_EVAL_GOLDEN_MISSING",
      `No golden set at ${filePath}. Scaffold one with \`brain-eval --init\` (or the /brain/eval page), then fill it with real queries.`
    );
  }
  const raw = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `The golden set at ${filePath} is not valid JSON.`);
  }
  const set = parsed as BrainGoldenSet;
  if (!set || typeof set !== "object" || !Number.isInteger(set.version) || set.version < 1 || !Array.isArray(set.queries)) {
    throw new PublicError(
      "BRAIN_EVAL_GOLDEN_INVALID",
      "The golden set must be an object with an integer `version` >= 1 and a `queries` array."
    );
  }
  const ids = new Set<string>();
  const queries: BrainGoldenQuery[] = [];
  for (const [index, query] of set.queries.entries()) {
    const where = `queries[${index}]`;
    if (!query || typeof query !== "object") {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden ${where} is not an object.`);
    }
    const { id, class: queryClass, query: text, expect } = query as BrainGoldenQuery;
    if (typeof id !== "string" || !id.trim()) {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden ${where} needs a non-empty string id.`);
    }
    if (ids.has(id)) {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden query id "${id}" appears more than once — ids must be unique.`);
    }
    ids.add(id);
    if (typeof queryClass !== "string" || !queryClass.trim()) {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden query "${id}" needs a non-empty class.`);
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden query "${id}" needs non-empty query text.`);
    }
    if (!Array.isArray(expect) || expect.length === 0 || expect.some((key) => typeof key !== "string" || !key.trim())) {
      throw new PublicError("BRAIN_EVAL_GOLDEN_INVALID", `Golden query "${id}" needs a non-empty \`expect\` array of source message keys.`);
    }
    if (expect.some((key) => key.includes("<")) || text.startsWith("replace me")) {
      throw new PublicError(
        "BRAIN_EVAL_GOLDEN_INVALID",
        `Golden query "${id}" still looks like the scaffold placeholder — replace it with a real query and real message keys.`
      );
    }
    queries.push({ id: id.trim(), class: queryClass.trim(), query: text, expect: expect.map((key) => key.trim()), note: query.note ?? null });
  }
  if (queries.length === 0) {
    throw new PublicError(
      "BRAIN_EVAL_GOLDEN_EMPTY",
      `The golden set at ${filePath} has no queries yet — add real queries before running the eval.`
    );
  }
  return { set: { ...set, queries }, info: goldenInfoFor(filePath, { ...set, queries }, raw) };
}

export function loadGoldenSetInfo(filePath = goldenSetPath()): BrainGoldenSetInfo | null {
  return goldenSetExists(filePath) ? loadGoldenSet(filePath).info : null;
}

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

// Execute the golden set through the shared search path and persist one
// comparable run. Yields between queries; never blocks the event loop.
export async function runBrainEval(
  repository: ArchiveRepository,
  options?: { goldenPath?: string; kValues?: number[]; notes?: string | null }
): Promise<BrainEvalRunRecord> {
  const { set, info } = loadGoldenSet(options?.goldenPath);
  const index = await repository.getSearchIndexStatus();
  if (index.state !== "ready") {
    throw new PublicError(
      "BRAIN_EVAL_INDEX_NOT_READY",
      "The search index needs a rebuild before an eval can run — run `npm run search:reindex` (or POST /api/search/reindex), then retry."
    );
  }
  const kValues = [...new Set((options?.kValues ?? BRAIN_EVAL_K_VALUES).map((k) => Math.max(1, Math.floor(k))))].sort((a, b) => a - b);
  const maxK = kValues[kValues.length - 1];
  // Invalid-expectation quarantine: a golden key that no longer resolves to an
  // archived message is a stale golden entry, never a retrieval miss.
  const existingKeys = await repository.filterExistingMessageKeys([...new Set(set.queries.flatMap((query) => query.expect))]);
  const perQuery: BrainEvalQueryResult[] = [];
  const skippedQueryIds: string[] = [];
  for (const query of set.queries) {
    const validExpected = query.expect.filter((key) => existingKeys.has(key));
    const invalidExpected = query.expect.filter((key) => !existingKeys.has(key));
    if (validExpected.length === 0) {
      skippedQueryIds.push(query.id);
      perQuery.push({
        queryId: query.id,
        class: query.class,
        query: query.query,
        validExpected,
        invalidExpected,
        ranks: {},
        recallAtK: {}
      });
      continue;
    }
    const response = await repository.searchMessages({ query: query.query, limit: maxK, offset: 0 });
    const rankByKey = new Map<string, number>();
    response.results.forEach((result, position) => {
      if (!rankByKey.has(result.sourceMessageKey)) {
        rankByKey.set(result.sourceMessageKey, position + 1);
      }
    });
    const ranks: Record<string, number | null> = {};
    for (const key of validExpected) {
      ranks[key] = rankByKey.get(key) ?? null;
    }
    const recallAtK: Record<string, number> = {};
    for (const k of kValues) {
      const found = validExpected.filter((key) => (ranks[key] ?? Number.POSITIVE_INFINITY) <= k).length;
      recallAtK[String(k)] = round(found / validExpected.length);
    }
    perQuery.push({ queryId: query.id, class: query.class, query: query.query, validExpected, invalidExpected, ranks, recallAtK });
    // Yield between queries so a long golden set never starves the event loop.
    await new Promise((resolve) => setImmediate(resolve));
  }
  const scored = perQuery.filter((result) => result.validExpected.length > 0);
  const classes = [...new Set(scored.map((result) => result.class))].sort();
  const perClass: BrainEvalClassStat[] = classes.map((queryClass) => {
    const members = scored.filter((result) => result.class === queryClass);
    const recallAtK: Record<string, number> = {};
    for (const k of kValues) {
      recallAtK[String(k)] = round(mean(members.map((member) => member.recallAtK[String(k)] ?? 0)));
    }
    return { class: queryClass, queries: members.length, recallAtK };
  });
  const totalsRecall: Record<string, number> = {};
  for (const k of kValues) {
    totalsRecall[String(k)] = round(mean(scored.map((member) => member.recallAtK[String(k)] ?? 0)));
  }
  const run: BrainEvalRunRecord = {
    id: randomUUID(),
    ranAtMs: Date.now(),
    target: BRAIN_EVAL_TARGET_ARCHIVE_SEARCH,
    goldenVersion: info.version,
    goldenHash: info.hash,
    kValues,
    queryCount: set.queries.length,
    skippedQueryIds,
    perClass,
    perQuery,
    totals: {
      queries: scored.length,
      recallAtK: totalsRecall,
      zeroHitQueries: scored.filter((member) => member.validExpected.every((key) => member.ranks[key] == null)).length
    },
    notes: options?.notes ?? null
  };
  await repository.insertBrainEvalRun(run);
  return run;
}

// Baseline resolution: an explicit run id wins; otherwise the most recent
// prior run with the SAME golden hash (cross-hash runs are labelled, never
// silently compared).
export async function resolveEvalBaseline(
  repository: ArchiveRepository,
  run: BrainEvalRunRecord,
  explicitBaselineId?: string | null
): Promise<BrainEvalRunRecord | null> {
  if (explicitBaselineId) {
    const baseline = await repository.getBrainEvalRun(explicitBaselineId);
    if (!baseline) {
      throw new PublicError("BRAIN_EVAL_BASELINE_MISSING", `No eval run with id ${explicitBaselineId} to use as a baseline.`);
    }
    return baseline;
  }
  const candidates = await repository.listBrainEvalRuns({ goldenHash: run.goldenHash, limit: 50 });
  return candidates.find((candidate) => candidate.id !== run.id && candidate.ranAtMs <= run.ranAtMs) ?? null;
}

// Gate verdict (design E9): pass iff every class's recall@k meets or exceeds
// the baseline. Regressions name the class, the k, and the offending queries
// (those that missed at least one expected key at that k).
export function computeEvalGate(run: BrainEvalRunRecord, baseline: BrainEvalRunRecord | null): BrainEvalGateVerdict {
  if (!baseline) {
    return { verdict: "no-baseline", runId: run.id, baselineRunId: null, sameGolden: true, regressions: [] };
  }
  const sameGolden = baseline.goldenHash === run.goldenHash;
  const regressions: BrainEvalGateRegression[] = [];
  const baselineByClass = new Map(baseline.perClass.map((stat) => [stat.class, stat]));
  for (const stat of run.perClass) {
    const baselineStat = baselineByClass.get(stat.class);
    if (!baselineStat) {
      continue;
    }
    for (const k of run.kValues) {
      const key = String(k);
      const runValue = stat.recallAtK[key];
      const baselineValue = baselineStat.recallAtK[key];
      if (runValue == null || baselineValue == null || runValue >= baselineValue) {
        continue;
      }
      regressions.push({
        class: stat.class,
        k,
        run: runValue,
        baseline: baselineValue,
        offendingQueryIds: run.perQuery
          .filter((result) => result.class === stat.class && result.validExpected.length > 0 && (result.recallAtK[key] ?? 0) < 1)
          .map((result) => result.queryId)
      });
    }
  }
  return {
    verdict: regressions.length > 0 ? "fail" : "pass",
    runId: run.id,
    baselineRunId: baseline.id,
    sameGolden,
    regressions
  };
}

// Shared human-readable report — the CLI prints the same lines whether it ran
// the eval directly or delegated to the server.
export function renderEvalReportLines(run: BrainEvalRunRecord, baseline?: BrainEvalRunRecord | null): string[] {
  const lines: string[] = [];
  const kHeaders = run.kValues.map((k) => `r@${k}`);
  lines.push(
    `Eval run ${run.id} — target ${run.target}, golden v${run.goldenVersion} (${run.goldenHash}), ${run.totals.queries}/${run.queryCount} queries scored`
  );
  if (run.skippedQueryIds.length > 0) {
    lines.push(`  skipped (no expected key resolves anymore — fix the golden set): ${run.skippedQueryIds.join(", ")}`);
  }
  const baselineByClass =
    baseline && baseline.goldenHash === run.goldenHash ? new Map(baseline.perClass.map((stat) => [stat.class, stat])) : null;
  const width = Math.max(10, ...run.perClass.map((stat) => stat.class.length + 2));
  lines.push(`  ${"class".padEnd(width)} ${"n".padStart(3)}  ${kHeaders.map((header) => header.padStart(12)).join(" ")}`);
  const formatCell = (value: number | undefined, baselineValue: number | undefined): string => {
    if (value == null) {
      return "—".padStart(12);
    }
    const percent = `${(value * 100).toFixed(1)}%`;
    if (baselineValue == null) {
      return percent.padStart(12);
    }
    const delta = value - baselineValue;
    const sign = delta > 0 ? "+" : "";
    return `${percent} (${sign}${(delta * 100).toFixed(1)})`.padStart(12);
  };
  for (const stat of run.perClass) {
    const baselineStat = baselineByClass?.get(stat.class);
    lines.push(
      `  ${stat.class.padEnd(width)} ${String(stat.queries).padStart(3)}  ${run.kValues
        .map((k) => formatCell(stat.recallAtK[String(k)], baselineStat?.recallAtK[String(k)]))
        .join(" ")}`
    );
  }
  lines.push(
    `  ${"overall".padEnd(width)} ${String(run.totals.queries).padStart(3)}  ${run.kValues
      .map((k) =>
        formatCell(
          run.totals.recallAtK[String(k)],
          baseline && baseline.goldenHash === run.goldenHash ? baseline.totals.recallAtK[String(k)] : undefined
        )
      )
      .join(" ")}`
  );
  if (run.totals.zeroHitQueries > 0) {
    lines.push(`  zero-hit queries: ${run.totals.zeroHitQueries}`);
  }
  if (baseline) {
    lines.push(
      baseline.goldenHash === run.goldenHash
        ? `  baseline: run ${baseline.id} (${new Date(baseline.ranAtMs).toISOString()})`
        : `  baseline run ${baseline.id} uses a DIFFERENT golden set (${baseline.goldenHash}) — cross-version, deltas not shown`
    );
  } else {
    lines.push("  baseline: none yet — this run becomes the baseline for the next one");
  }
  return lines;
}
