import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanupSensitiveWorkDirs } from "./cleanup";
import { config } from "./config";
import { archiveAdapterLabel, createArchiveRepository, initializeArchiveDatabase } from "./db/archive";
import { SqliteArchiveRepository } from "./db/sqliteRepository";
import { configuredTraceRecorder, getTraceRecorderSummary } from "./diagnostics/traceRecorder";
import { runDoctor } from "./doctor";
import { inspectArchive } from "./import/inspect";
import { listWaContacts } from "./import/waContacts";
import { runImport } from "./import/importer";
import { parseWorksheetAnnotations, renderUnknownTypeReport } from "./import/unknownTypeReport";
import { createSyntheticFixture } from "./import/fixtures";
import { BaileysLiveWhatsAppClient, runBaileysProof } from "./live/baileysClient";
import { closeLegacyWallClockGaps } from "./live/auditor";
import { assertLiveBaselineExists } from "./live/baseline";
import { LiveMaintainer, liveOptionsFromConfig } from "./live/maintainer";
import { ImportTerminalProgress, type ImportProgressEvent } from "./import/progress";
import { publicErrorMessage, redactForDisplay, safeBasename } from "./privacy";
import { queryMemory, resolveMemoryCitation, runMemoryConsolidation, validateMemoryStore } from "./memory/consolidation";
import { connectCodexProvider, disableRemoteMemoryProvider, enableCodexProvider, getMemoryProviderStatus } from "./memory/provider";

type Args = Record<string, string | boolean>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "init-db") {
    await initializeArchiveDatabase();
    console.log(`${archiveAdapterLabel()} archive initialized.`);
    return;
  }

  if (command === "doctor") {
    const checks = await runDoctor();
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4, " ");
      console.log(`${label} ${check.name}: ${check.message}`);
    }
    if (checks.some((check) => check.status === "fail")) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "trace-status") {
    console.log(JSON.stringify(getTraceRecorderSummary(), null, 2));
    return;
  }

  if (command === "cleanup") {
    const summary = await cleanupSensitiveWorkDirs();
    console.log(
      `Cleanup complete: removed_files=${summary.removedFiles} removed_directories=${summary.removedDirectories}`
    );
    return;
  }

  if (command === "generate-fixtures") {
    const dir = String(args.dir ?? args._ ?? "fixtures/generated/basic");
    const fixture = await createSyntheticFixture(path.resolve(dir), {
      large: Boolean(args.large),
      manyChats: numberArg(args["many-chats"]),
      missingOptional: Boolean(args["missing-optional"]),
      privacyCanary: Boolean(args["privacy-canary"])
    });
    console.log(`Synthetic fixture created: ${path.basename(fixture.directory)}`);
    console.log(`msgstore: ${fixture.msgstorePath}`);
    console.log(`wa: ${fixture.waPath}`);
    return;
  }

  if (command === "inspect") {
    const msgstorePath = stringArg(args.msgstore);
    if (!msgstorePath) {
      throw new Error("Missing --msgstore path.");
    }
    const summary = await inspectArchive({
      msgstorePath,
      waPath: stringArg(args.wa),
      key: stringArg(args.key),
      keyPath: stringArg(args["key-file"]),
      keepDecrypted: Boolean(args["keep-decrypted"])
    });
    console.log(
      `Inspect complete: supported=${summary.supported} schema=${summary.schemaKind} tables=${summary.counts.tables} chats=${summary.counts.chats} contacts=${summary.counts.contacts} warnings=${summary.counts.warnings}`
    );
    for (const warning of summary.warnings.slice(0, 10)) {
      console.log(`WARN ${warning.code}: ${warning.message}`);
    }
    return;
  }

  if (command === "import") {
    await runImportCommand(args);
    return;
  }

  if (command === "wa-contacts") {
    const waPath = stringArg(args.wa) ?? stringArg(args._);
    if (!waPath) {
      throw new Error("Missing --wa path.");
    }
    const summary = await listWaContacts({
      waPath,
      key: stringArg(args.key),
      keyPath: stringArg(args["key-file"]),
      keepDecrypted: Boolean(args["keep-decrypted"])
    });
    console.log(
      `wa.db contacts: total=${summary.totalContacts} resolved=${summary.resolvedCount} unresolved=${summary.unresolvedCount}`
    );
    const showAll = Boolean(args.all);
    if (showAll) {
      console.log("\nAll contacts:");
      for (const contact of summary.contacts) {
        printContactRow(contact);
      }
    } else if (summary.unresolvedCount > 0) {
      console.log("\nContacts with no resolved name (pass --all to list every contact):");
      for (const contact of summary.contacts) {
        if (!contact.resolved) {
          printContactRow(contact);
        }
      }
    }
    return;
  }

  if (command === "brain-status") {
    const { getBrainProviderStatus } = await import("./brain/provider");
    const repository = createArchiveRepository();
    try {
      const status = await repository.getBrainStatus();
      const provider = getBrainProviderStatus();
      console.log(JSON.stringify({ ...status, provider }, null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "brain-provider") {
    const { disableBrainProvider, enableBrainProvider, getBrainProviderStatus, probeBrainProvider, setBrainProviderModel } =
      await import("./brain/provider");
    const action = stringArg(args._) ?? "status";
    if (action === "set-model") {
      const provider = stringArg(args.provider);
      const model = stringArg(args.model);
      if ((provider !== "claude-cli" && provider !== "codex") || !model) {
        throw new Error("Usage: brain-provider set-model --provider <claude-cli|codex> --model <name>");
      }
      const status = setBrainProviderModel(provider, model);
      console.log(`Model for ${provider} set to ${model}. ${status.message}`);
    } else if (action === "enable-claude-cli") {
      console.log(enableBrainProvider("claude-cli").message);
    } else if (action === "enable-codex") {
      console.log(enableBrainProvider("codex").message);
    } else if (action === "disable") {
      console.log(disableBrainProvider().message);
    } else if (action === "login-codex") {
      // Interactive OAuth belongs in a terminal, never inside the server.
      console.log("Starting the interactive Codex login…");
      await connectCodexProvider();
      const { getBrainProviderStatus: statusAfterLogin } = await import("./brain/provider");
      console.log(statusAfterLogin().message);
    } else if (action === "probe") {
      console.log("Probing the model provider end-to-end (this makes one tiny model call)…");
      const probe = await probeBrainProvider();
      console.log(probe.ok ? `PROBE OK — ${probe.status.message}` : `PROBE FAILED — ${probe.status.message}`);
      if (!probe.ok) {
        process.exitCode = 1;
      }
    } else {
      const status = getBrainProviderStatus();
      console.log(JSON.stringify(status, null, 2));
    }
    return;
  }

  // Drive a brain run from the terminal (best run with the server stopped —
  // SQLite is single-writer). --provider/--model set the persisted selection
  // before running; --extractive forces the no-model path; --max-chats caps how
  // many backlog chats (by pending count) drain; --chat <sourceId> targets ONE
  // chat regardless of ordering; --max-model-calls caps spend (partial coverage
  // commits and resumes next run).
  if (command === "brain-run") {
    const { enableBrainProvider, getBrainProviderStatus, setBrainProviderModel } = await import("./brain/provider");
    const provider = stringArg(args.provider);
    const model = stringArg(args.model);
    if (provider === "claude-cli" || provider === "codex") {
      enableBrainProvider(provider);
      if (model) {
        setBrainProviderModel(provider, model);
      }
    }
    const status = getBrainProviderStatus();
    const mode = Boolean(args.extractive) || !status.modelBacked || !status.enabled ? "extractive" : "model";
    // --chat scopes the run to exactly one chat (bypassing the pending-count
    // ordering); --max-model-calls hard-caps spend, committing partial coverage
    // and leaving the rest resumable. Together: a bounded, targeted assimilation.
    const chatSourceId = stringArg(args.chat) ?? null;
    const maxModelCalls = numberArg(args["max-model-calls"]);
    const repository = createArchiveRepository();
    try {
      const { startBrainRun, getBrainRunProgress } = await import("./brain/runJob");
      const started = startBrainRun(repository, {
        mode,
        model: model ?? null,
        chatSourceId,
        maxChats: numberArg(args["max-chats"]) ?? 10,
        maxModelCalls: maxModelCalls ?? undefined
      });
      if (!started.started) {
        console.error(started.refusal ?? "Could not start the brain run.");
        process.exitCode = 1;
        return;
      }
      console.log(
        `Brain run started (${mode}${mode === "model" && model ? `/${model}` : ""})${chatSourceId ? ` — chat ${chatSourceId}` : ""}${maxModelCalls ? `, ≤${maxModelCalls} model call(s)` : ""}…`
      );
      while (getBrainRunProgress().state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const final = getBrainRunProgress();
      console.log(
        `Run ${final.state}: ${final.episodesCommitted} episode(s), ${final.claimsCommitted} claim(s) across ${final.processedChats} chat(s), ${final.modelCalls} model call(s).${final.error ? ` ${final.error}` : ""}`
      );
      if (final.state === "failed") {
        process.exitCode = 1;
      }
    } finally {
      await repository.close?.();
    }
    return;
  }

  // Regenerate stale episodes (contract v2): current episodes that are
  // extractive-generated or carry a stale extraction_version are re-derived
  // from their stored windows under the current contract; old rows become
  // 'superseded'. Watermarks are untouched. --chat scopes to one chat;
  // --dry-run only counts; --provider/--model as in brain-run. Model mode is
  // required (an extractive re-run would downgrade model episodes). Run with
  // the server STOPPED (SQLite is single-writer).
  if (command === "brain-regenerate") {
    const { enableBrainProvider, setBrainProviderModel } = await import("./brain/provider");
    const provider = stringArg(args.provider);
    const model = stringArg(args.model);
    if (provider === "claude-cli" || provider === "codex") {
      enableBrainProvider(provider);
      if (model) {
        setBrainProviderModel(provider, model);
      }
    }
    const chatSourceId = stringArg(args.chat) ?? null;
    const repository = createArchiveRepository();
    try {
      const { EXTRACTION_VERSION } = await import("./brain/episodes");
      const stale = await repository.listRegenerableBrainEpisodes({ currentVersion: EXTRACTION_VERSION, chatSourceId, limit: 10_000 });
      console.log(
        `${stale.length} episode(s) need regeneration (extractive or extraction_version < ${EXTRACTION_VERSION})${chatSourceId ? ` in chat ${chatSourceId}` : ""}.`
      );
      if (args["dry-run"] || stale.length === 0) {
        return;
      }
      const { startBrainRun, getBrainRunProgress } = await import("./brain/runJob");
      const started = startBrainRun(repository, { mode: "model", model: model ?? null, chatSourceId, regenerate: true });
      if (!started.started) {
        console.error(started.refusal ?? "Could not start the regeneration run.");
        process.exitCode = 1;
        return;
      }
      while (getBrainRunProgress().state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const final = getBrainRunProgress();
      console.log(
        `Regeneration ${final.state}: ${final.episodesCommitted} replacement episode(s), ${final.claimsCommitted} claim(s), ${final.processedChats}/${final.totalChats} superseded, ${final.modelCalls} model call(s).${final.error ? ` ${final.error}` : ""}`
      );
      if (final.state === "failed") {
        process.exitCode = 1;
      }
    } finally {
      await repository.close?.();
    }
    return;
  }

  // Wipe derived brain data for a clean slate (episodes + claims + citations +
  // watermarks + projected .md files + the task queue) — raw messages untouched;
  // the next run re-assimilates from scratch. --chat <sourceId> scopes it to one
  // chat. Run with the server STOPPED (SQLite is single-writer).
  if (command === "brain-reset") {
    const chatSourceId = stringArg(args.chat) ?? null;
    const repository = createArchiveRepository();
    try {
      const result = await repository.resetBrainDerivedData({ chatSourceId });
      const { clearAllProjectedEpisodeFiles, deleteProjectedEpisodeFiles } = await import("./brain/episodes");
      const filesRemoved = chatSourceId ? deleteProjectedEpisodeFiles(result.episodeIds) : clearAllProjectedEpisodeFiles();
      console.log(
        `Brain reset${chatSourceId ? ` (chat ${chatSourceId})` : ""}: removed ${result.episodeIds.length} episode(s), ${result.watermarks} watermark(s), ${filesRemoved} projected file(s), and cleared pending tasks. Raw messages are untouched.`
      );
    } finally {
      await repository.close?.();
    }
    return;
  }

  // Set (or correct) a contact's display name and fire identity late-resolution:
  // the deterministic, model-free repair substitutes the person's baked number in
  // old episode summaries/claims and recomputes their search text, so saving a
  // contact retroactively improves the brain. --jid <sourceJid> --name "<name>".
  // Run with the server STOPPED (SQLite is single-writer).
  if (command === "set-contact-name") {
    const jid = stringArg(args.jid);
    const name = stringArg(args.name);
    if (!jid || !name) {
      console.error('Usage: set-contact-name --jid <sourceJid> --name "<display name>"');
      process.exitCode = 1;
      return;
    }
    const repository = createArchiveRepository();
    try {
      const canonical = await repository.resolveIdentityJid(jid);
      // Episodes currently referring to this person by number (repaired below).
      const before = await repository.getBrainResolutionDebt({ limit: 10_000 });
      const willRepair = before.topIdentities.find((identity) => identity.jid === canonical)?.episodeCount ?? 0;
      const phone = jid.split("@")[0]?.replace(/\D/g, "") || null;
      // upsertContacts detects the name transition and routes through the one
      // repair entry point (prose substitution + FTS recompute) with no model call.
      await repository.upsertContacts("cli-set-contact-name", [{ sourceJid: jid, displayName: name, phoneNumber: phone }]);
      const after = await repository.getBrainResolutionDebt({ limit: 5 });
      console.log(`Set "${name}" for ${canonical}.`);
      console.log(
        `Repaired ${willRepair} episode(s) that referred to this person by number — prose substituted, search text recomputed, no model call.`
      );
      console.log(
        `Resolution debt: ${before.episodesWithUnresolved} → ${after.episodesWithUnresolved} episode(s) with any unresolved participant; ` +
          `${before.distinctIdentities} → ${after.distinctIdentities} distinct identities.`
      );
      if (willRepair > 0 && after.episodesWithUnresolved > 0) {
        console.log(
          "(Group episodes that also mention other unsaved people stay counted — expected; this person's prose is repaired.)"
        );
      }
    } finally {
      await repository.close?.();
    }
    return;
  }

  // Force one brain scheduler pass on demand — catch-up enqueue → drain → cited
  // episodes → run object — without waiting for the nightly cutoff or an auto
  // tick (and without needing live sync connected). Handy for a quick test or an
  // ops "assimilate now". --reset wipes existing episodes first (clean slate);
  // --calls caps model spend for the pass; --extractive runs free with
  // placeholder episodes (your real provider config is untouched). Run with the
  // server STOPPED — SQLite is single-writer.
  if (command === "brain-pass") {
    const calls = numberArg(args.calls);
    if (calls) {
      config.brain.maxCallsPerHour = calls;
    }
    if (args.extractive) {
      config.brain.providerConfigPath = path.join(config.brain.rootDir, `_brain-pass-extractive-${Date.now()}.json`);
    }
    const repository = createArchiveRepository();
    try {
      if (args.reset) {
        const wiped = await repository.resetBrainDerivedData({ chatSourceId: null });
        const { clearAllProjectedEpisodeFiles } = await import("./brain/episodes");
        const filesRemoved = clearAllProjectedEpisodeFiles();
        console.log(`Reset first: removed ${wiped.episodeIds.length} episode(s), ${wiped.watermarks} watermark(s), ${filesRemoved} file(s).`);
      }
      const { computeDueWork, runBrainMaintenancePass } = await import("./brain/scheduler");
      const before = await repository.getBrainStatus();
      const due = await computeDueWork(repository);
      console.log(`Coverage ${before.coveragePercent}% — ${due.dueChats.length} chat(s) due${due.runDue ? `: ${due.dueReason}` : " (nothing due)"}`);
      console.log(`Forcing one brain pass (${args.extractive ? "extractive" : "model"}${calls ? `, ≤${calls} model calls` : ""})…`);
      const result = await runBrainMaintenancePass(repository, { force: true });
      console.log(JSON.stringify(result, null, 2));
      const after = await repository.getBrainStatus();
      console.log(`Coverage now ${after.coveragePercent}% — latest run ${after.latestRun?.status ?? "none"}, ${after.usageToday.calls} model call(s) today.`);
      const [episode] = await repository.listBrainEpisodes({ limit: 1 });
      if (episode) {
        console.log(`Newest episode (${episode.generator}${episode.model ? `/${episode.model}` : ""}) — ${episode.chatDisplayName ?? episode.chatSourceId}: ${episode.summary}`);
        console.log(`Episodes are in ${path.join(config.brain.rootDir, "episodes")} (open the .md in Obsidian).`);
      }
      console.log("Undo anytime via the Brain panel Reset or POST /api/brain/reset.");
    } finally {
      await repository.close?.();
    }
    return;
  }

  // Two-level person model: run the deterministic person pass on demand —
  // certainty-grade auto-connect (google groupings + number-change events)
  // and, unless --connect-only, the suggestion detectors. Metadata-only by
  // construction (episodes/claims/citations are never touched). Run with the
  // server STOPPED — SQLite is single-writer.
  if (command === "persons-scan") {
    const repository = createArchiveRepository();
    try {
      const { runPersonAutoConnectPass } = await import("./persons/autoConnect");
      const autoConnect = await runPersonAutoConnectPass(repository);
      console.log(
        `Auto-connect: ${autoConnect.googleConnected} via google grouping, ${autoConnect.numberChangeConnected} via number change, ` +
          `${autoConnect.unions} union(s), ${autoConnect.skippedSuppressed} suppressed pair(s) skipped.`
      );
      if (!args["connect-only"]) {
        const { runPersonSuggestionDetectors } = await import("./persons/suggestions");
        const detected = await runPersonSuggestionDetectors(repository);
        console.log(`Suggestions: ${detected.created} new, ${detected.updated} updated.`);
        for (const [kind, count] of Object.entries(detected.byDetector)) {
          if (count > 0) {
            console.log(`  ${kind}: ${count}`);
          }
        }
      }
      const persons = await repository.listPersons({ limit: 200 });
      console.log(`Persons: ${persons.length}`);
      for (const person of persons.slice(0, 20)) {
        const members = person.members
          .map((member) => `${member.displayLabel ?? member.identityJid} [${member.source}]`)
          .join(" + ");
        console.log(`  ${person.displayLabel ?? person.id}: ${members}`);
      }
      const pending = await repository.listPersonSuggestions({ status: "pending", limit: 20 });
      console.log(`Pending suggestions: ${pending.length}`);
      for (const suggestion of pending) {
        console.log(`  [${suggestion.kind} ${suggestion.score.toFixed(2)}] ${suggestion.lowLabel} ↔ ${suggestion.highLabel}`);
      }
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "search-reindex") {
    const repository = createArchiveRepository();
    try {
      const status = await repository.getSearchIndexStatus();
      console.log(`Search index state: ${status.state} (${status.totalMessages.toLocaleString()} messages).`);
      const { default: cliProgress } = await import("cli-progress");
      const bar = new cliProgress.SingleBar(
        { format: "Reindexing [{bar}] {percentage}% | {value}/{total} messages" },
        cliProgress.Presets.shades_classic
      );
      let started = false;
      const result = await repository.rebuildSearchIndex((processed, total) => {
        if (!started) {
          bar.start(Math.max(total, 1), Math.min(processed, total));
          started = true;
        }
        bar.setTotal(Math.max(total, 1));
        bar.update(Math.min(processed, total));
      });
      if (started) {
        bar.stop();
      }
      console.log(`Search index rebuilt: ${result.indexedMessages.toLocaleString()} messages indexed.`);
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "unknown-report") {
    const repository = createArchiveRepository();
    try {
      const entries = await repository.listUnknownTypeCodes();
      const outputPath = path.join(path.dirname(config.archive.sqlitePath), "unknown-type-report.md");
      const existing = existsSync(outputPath) ? await readFile(outputPath, "utf8") : null;
      const annotations = parseWorksheetAnnotations(existing);
      const markdown = renderUnknownTypeReport(entries, annotations, new Date().toISOString());
      await writeFile(outputPath, markdown, "utf8");
      const annotated = entries.filter((entry) => annotations.has(entry.code)).length;
      console.log(
        `Unknown-type worksheet regenerated: ${entries.length} code(s) remain (${annotated} annotated). ${displayPath(outputPath)}`
      );
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-status") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await repository.getLiveStatus(), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-gaps") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await repository.listLiveGaps(["open", "retrying", "uncertain", "needs_user_action"]), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-retry-gap") {
    const id = numberArg(args.id ?? args._);
    if (!id) {
      throw new Error("Missing --id for live gap retry.");
    }
    const repository = createArchiveRepository();
    try {
      await repository.updateLiveGapStatus(id, "open", "User requested retry from CLI.");
      console.log(`Gap ${id} scheduled for retry.`);
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "live-cleanup-state" || command === "live-unlink") {
    await rm(config.live.authDir, { recursive: true, force: true });
    console.log(`Live auth state removed from ${displayPath(config.live.authDir)}.`);
    return;
  }

  if (command === "live-proof") {
    const repository = createArchiveRepository();
    try {
      await assertLiveBaselineExists(repository, config.live.maxBackfillPerChatDays);
    } finally {
      await repository.close?.();
    }
    const result = await runBaileysProof({
      phoneNumber: stringArg(args.phone),
      timeoutMs: numberArg(args.timeout) ?? 60_000
    });
    console.log(`Baileys proof complete: connected=${result.connected} messages_upsert=${result.receivedMessagesUpsert} history_sync=${result.receivedHistorySync}`);
    console.log(`Result written to ${displayPath(config.live.spikePath)}.`);
    for (const note of result.notes) {
      console.log(note);
    }
    return;
  }

  if (command === "live-start") {
    await runLiveStartCommand(args);
    return;
  }

  if (command === "memory-status") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await repository.getMemoryStatus(await getMemoryProviderStatus()), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "memory-provider") {
    await runMemoryProviderCommand(args);
    return;
  }

  if (command === "memory-rem" || command === "memory-consolidate") {
    await runMemoryConsolidationCommand(args, command === "memory-rem" ? "rem" : "manual");
    return;
  }

  if (command === "memory-query") {
    const query = stringArg(args.query) ?? stringArg(args._);
    if (!query) {
      throw new Error("Missing --query for memory-query.");
    }
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await queryMemory(repository, query), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "memory-citation") {
    const citation = stringArg(args.citation) ?? stringArg(args._);
    if (!citation) {
      throw new Error("Missing --citation for memory-citation.");
    }
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await resolveMemoryCitation(repository, citation), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  if (command === "memory-validate") {
    const repository = createArchiveRepository();
    try {
      console.log(JSON.stringify(await validateMemoryStore(repository), null, 2));
    } finally {
      await repository.close?.();
    }
    return;
  }

  printHelp();
}

async function runLiveStartCommand(args: Args): Promise<void> {
  const repository = createArchiveRepository();
  const options = liveOptionsFromConfig();
  await repository.reconcileLiveState();
  await closeLegacyWallClockGaps(repository);
  // Linking needs an archive to exist; age never blocks pairing or resume.
  if (!existsSync(path.join(options.authDir, "creds.json"))) {
    await assertLiveBaselineExists(repository, options.maxBackfillPerChatDays);
  }
  const client = new BaileysLiveWhatsAppClient({
    authDir: options.authDir,
    phoneNumber: stringArg(args.phone),
    connectTimeoutMs: numberArg(args.timeout)
  });
  const maintainer = new LiveMaintainer(repository, client, options);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await maintainer.stop();
    await repository.close?.();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    const runId = await maintainer.start();
    console.log(`Live maintainer started: run=${runId}`);
    console.log("Press Ctrl+C to stop.");
    if (Boolean(args.once)) {
      await maintainer.runRecoveryOnce();
      await stop();
      return;
    }
    await new Promise(() => undefined);
  } catch (error) {
    await maintainer.fail(error);
    await repository.close?.();
    throw error;
  }
}

async function runImportCommand(args: Args): Promise<void> {
  const msgstorePath = stringArg(args.msgstore) ?? stringArg(args._);
  if (!msgstorePath) {
    throw new Error("Missing --msgstore path.");
  }

  const waPath = stringArg(args.wa) ?? stringArg(args["wa-db"]);
  const mediaPath = stringArg(args.media) ?? stringArg(args["media-dir"]);
  const archivePath = stringArg(args.archive) ?? stringArg(args["archive-db"]) ?? stringArg(args.db);
  const keyPath = stringArg(args["key-file"]);
  const logger = await createCliLogger("import");
  const progress = new ImportTerminalProgress();
  const repository = archivePath ? new SqliteArchiveRepository(path.resolve(archivePath)) : createArchiveRepository();
  const logPathForDisplay = displayPath(logger.logPath);

  console.log(`Debug log: ${logPathForDisplay}`);
  logger.info("import command started", {
    msgstore: safeBasename(msgstorePath),
    wa: safeBasename(waPath),
    media: safeBasename(mediaPath),
    archive: safeBasename(archivePath ?? config.archive.sqlitePath),
    hasInlineKey: Boolean(stringArg(args.key)),
    hasKeyFile: Boolean(keyPath),
    keepDecrypted: Boolean(args["keep-decrypted"])
  });
  await logInputSummary(logger, "msgstore", msgstorePath);
  if (waPath) {
    await logInputSummary(logger, "wa.db", waPath);
  }
  if (mediaPath) {
    await logInputSummary(logger, "media", mediaPath);
  }

  const onProgress = createProgressHandler(progress, logger);
  try {
    const totals = await runImport(
      repository,
      {
        msgstorePath,
        waPath,
        mediaPath,
        key: stringArg(args.key),
        keyPath,
        keepDecrypted: Boolean(args["keep-decrypted"])
      },
      { onProgress }
    );
    progress.complete(totals);
    logger.info("import command completed", { totals });
    await configuredTraceRecorder?.snapshotArchive("after-cli-import", archivePath ? path.resolve(archivePath) : config.archive.sqlitePath);
    console.log(
      `Import complete: chats=${totals.chats} contacts=${totals.contacts} participants=${totals.participants} messages=${totals.messages} skipped=${totals.skipped} warnings=${totals.warnings}`
    );
  } catch (error) {
    progress.fail(publicErrorMessage(error));
    logger.error("import command failed", serializeError(error));
    console.error(`Import failed: ${publicErrorMessage(error)}`);
    console.error(`Debug log: ${logPathForDisplay}`);
    process.exitCode = 1;
  } finally {
    await repository.close?.();
    await logger.close();
  }
}

async function runMemoryProviderCommand(args: Args): Promise<void> {
  const action = stringArg(args.action) ?? stringArg(args._) ?? "status";
  if (action === "enable-codex") {
    console.log(JSON.stringify(await enableCodexProvider(), null, 2));
    return;
  }
  if (action === "disable") {
    console.log(JSON.stringify(await disableRemoteMemoryProvider(), null, 2));
    return;
  }
  if (action === "login") {
    console.log(JSON.stringify(await connectCodexProvider(), null, 2));
    return;
  }
  console.log(JSON.stringify(await getMemoryProviderStatus(), null, 2));
}

async function runMemoryConsolidationCommand(args: Args, kind: "rem" | "manual"): Promise<void> {
  const repository = createArchiveRepository();
  try {
    const result = await runMemoryConsolidation(repository, {
      kind: Boolean(args.rebuild) ? "rebuild" : kind,
      startAtMs: numberArg(args["start-ms"]) ?? null,
      endAtMs: numberArg(args["end-ms"]) ?? null,
      chatSourceIds: stringArg(args.chats)?.split(",").map((chat) => chat.trim()).filter(Boolean),
      dryRun: Boolean(args["dry-run"]),
      force: Boolean(args.force)
    });
    console.log(
      `Memory ${result.dryRun ? "dry run" : "run"} ${result.run.status}: run=${result.run.id} pages=${result.pages.length} messages=${result.run.messageCount} citations=${result.run.citationCount}`
    );
    if (result.previewPath) {
      console.log(`Evidence preview written under private memory dir: ${displayPath(result.previewPath)}`);
    }
    if (result.issues.length) {
      console.log(`Validation issues: ${result.issues.map((issue) => issue.code).join(", ")}`);
    }
  } finally {
    await repository.close?.();
  }
}

function createProgressHandler(progress: ImportTerminalProgress, logger: CliLogger): (event: ImportProgressEvent) => void {
  let lastFileLogAt = 0;
  let lastMessageLogAt = 0;
  return (event) => {
    progress.handle(event);
    const now = Date.now();
    if (event.type === "file-progress") {
      const done = event.processedBytes >= event.totalBytes;
      if (!done && now - lastFileLogAt < 5000) {
        return;
      }
      lastFileLogAt = now;
    }
    if (event.type === "message-progress") {
      const done = event.totalMessages != null && event.processedMessages >= event.totalMessages;
      if (!done && now - lastMessageLogAt < 5000) {
        return;
      }
      lastMessageLogAt = now;
    }
    logger.debug("progress", event);
  };
}

interface CliLogger {
  logPath: string;
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function createCliLogger(prefix: string): Promise<CliLogger> {
  const logDir = path.resolve(config.workDir, "logs");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${prefix}-${stamp}-${randomBytes(4).toString("hex")}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  const write = (level: string, message: string, context?: Record<string, unknown>) => {
    const entry = sanitizeLogValue({
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context ?? null
    });
    stream.write(`${JSON.stringify(entry)}\n`);
  };
  write("info", "log started", { log: path.basename(logPath) });
  return {
    logPath,
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(resolve);
      })
  };
}

async function logInputSummary(logger: CliLogger, label: string, inputPath: string): Promise<void> {
  try {
    const inputStat = await stat(inputPath);
    logger.debug("input summary", {
      label,
      basename: path.basename(inputPath),
      kind: inputStat.isDirectory() ? "directory" : "file",
      sizeBytes: inputStat.isFile() ? inputStat.size : null
    });
  } catch (error) {
    logger.warn("input summary unavailable", { label, error: publicErrorMessage(error) });
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : null;
    return {
      name: error.name,
      code,
      publicMessage: publicErrorMessage(error),
      stack: redactForDisplay(error.stack ?? error.message)
    };
  }
  return { publicMessage: publicErrorMessage(error) };
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactForDisplay(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, sanitizeLogValue(nestedValue)])
    );
  }
  return value;
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function parseArgs(values: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = values[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else if (!args._) {
      args._ = value;
    }
  }
  return args;
}

function stringArg(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberArg(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function printContactRow(contact: { jid: string; number: string | null; displayName: string | null; resolved: boolean }): void {
  const label = contact.resolved ? "OK  " : "MISS";
  const name = contact.displayName ?? "(no name)";
  const number = contact.number ? ` (${contact.number})` : "";
  console.log(`  ${label} ${contact.jid}${number} - ${name}`);
}

function printHelp(): void {
  console.log(`Usage:
  npm run init-db
  npm run doctor
  npm run cleanup
  npm run trace-status
  npm run generate-fixtures -- --dir fixtures/generated/basic
  npm run inspect -- --msgstore <msgstore.db|msgstore.db.crypt15> [--wa <wa.db|wa.db.crypt15>] [--key <64-hex-key> | --key-file <encrypted_backup.key>]
  npm run import -- --msgstore <msgstore.db.crypt15> [--wa <wa.db|wa.db.crypt15>] [--media <WhatsApp/Media>] [--archive <archive.sqlite>] [--key <64-hex-key> | --key-file <encrypted_backup.key>]
  npm run wa-contacts -- --wa <wa.db|wa.db.crypt15> [--key <64-hex-key> | --key-file <encrypted_backup.key>] [--all]
  tsx src/server/cli.ts live-proof [--phone <countrycode-number>] [--timeout <ms>]
  tsx src/server/cli.ts live-start [--phone <countrycode-number>] [--once]
  tsx src/server/cli.ts live-status
  tsx src/server/cli.ts live-gaps
  tsx src/server/cli.ts live-retry-gap --id <gap-id>
  tsx src/server/cli.ts live-unlink
  tsx src/server/cli.ts set-contact-name --jid <sourceJid> --name "<display name>"
  tsx src/server/cli.ts persons-scan [--connect-only]
  tsx src/server/cli.ts memory-status
  tsx src/server/cli.ts memory-provider [status|enable-codex|login|disable]
  tsx src/server/cli.ts memory-rem [--dry-run] [--force]
  tsx src/server/cli.ts memory-consolidate [--start-ms <ms>] [--end-ms <ms>] [--chats <source-chat-id,...>] [--dry-run] [--force]
  tsx src/server/cli.ts memory-query --query <text>
  tsx src/server/cli.ts memory-citation --citation <label-or-source-message-key>
  tsx src/server/cli.ts memory-validate

Notes:
  - Keys and message contents are never printed by the CLI.
  - Encrypted backups and contacts sidecars are crypt15-only; plaintext msgstore.db and wa.db remain supported for fixtures or already-decrypted local files.
  - By default, imports write to the local SQLite file configured by ARCHIVE_DB_PATH or .wapp-brain/archive.sqlite.
  - Each import writes a unique verbose debug log under .wapp-brain/logs.
  - Set WAPP_TRACE_NAME=<name> to record exact local diagnostic traces under .wapp-brain/traces.
  - inspect reports schema compatibility and counts without message bodies.
  - wa-contacts decrypts only the contacts sidecar and lists which contacts have a resolved name and which don't.
  - live-* commands are explicit opt-in and store auth/session state only under .wapp-brain/live.
  - memory-* commands write private generated Markdown, sidecars, and provider session state under .wapp-brain/memory by default.
  - Use --keep-decrypted only if you intentionally want decrypted databases left in the local work directory.
  - cleanup removes app-managed decrypted working files and import staging files.`);
}

main().catch((error) => {
  console.error(publicErrorMessage(error));
  process.exitCode = 1;
});
