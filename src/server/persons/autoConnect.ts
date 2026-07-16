import type { ArchiveRepository } from "../db/repository";
import type { PersonAutoConnectSummary, PersonConnectResult } from "../../shared/types";
import { recordAutoConnectRun } from "./scanStatus";

// Deterministic person auto-connect: exactly two certainty-grade sources
// connect identities without confirmation — numbers sharing one persisted
// Google contact grouping, and WhatsApp "changed their phone number" system
// messages. The pass is a full scan over small indexed surfaces and connect
// is idempotent (co-member pairs no-op, suppressed pairs are skipped), so
// backfill over an existing archive and the continuous steady state are the
// same code path. Runs after Google syncs, after backup imports, and on the
// live recovery tick; never touches episodes, claims, or archive rows.

export type PersonAutoConnectSource = "google" | "number_change";

export interface PersonAutoConnectOptions {
  sources?: PersonAutoConnectSource[];
  // Yield to the event loop after this many connect attempts so a large
  // backfill never stalls ingestion (better-sqlite3 is synchronous).
  yieldEvery?: number;
  // Bound on number-change rows examined per pass (the table is small; this
  // is a runaway guard, not a coverage knob).
  maxNumberChanges?: number;
}

export async function runPersonAutoConnectPass(
  repository: ArchiveRepository,
  options: PersonAutoConnectOptions = {}
): Promise<PersonAutoConnectSummary> {
  const sources = options.sources ?? ["google", "number_change"];
  const yieldEvery = Math.max(1, options.yieldEvery ?? 25);
  const summary: PersonAutoConnectSummary = { googleConnected: 0, numberChangeConnected: 0, unions: 0, skippedSuppressed: 0 };
  let attempts = 0;
  const maybeYield = async (): Promise<void> => {
    attempts += 1;
    if (attempts % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const count = (result: PersonConnectResult, key: "googleConnected" | "numberChangeConnected"): void => {
    if (result.outcome === "connected" || result.outcome === "union") {
      summary[key] += 1;
      if (result.outcome === "union") {
        summary.unions += 1;
      }
    } else if (result.outcome === "suppressed") {
      summary.skippedSuppressed += 1;
    }
  };

  if (sources.includes("google")) {
    const groups = await repository.listGoogleContactGroups();
    const byResource = new Map<string, string[]>();
    for (const group of groups) {
      byResource.set(group.resourceName, [...(byResource.get(group.resourceName) ?? []), group.phoneE164]);
    }
    const jidsByPhone = await repository.resolveArchivedJidsForPhones([...new Set(groups.map((group) => group.phoneE164))]);
    for (const [resourceName, phones] of byResource) {
      // Distinct archived canonical identities across this contact's numbers,
      // matched the same way name enrichment matches.
      const jids = [...new Set(phones.flatMap((phone) => jidsByPhone.get(phone) ?? []))].sort();
      if (jids.length < 2) {
        continue;
      }
      const [anchor, ...rest] = jids;
      for (const jid of rest) {
        count(await repository.connectIdentities(anchor, jid, "google", { resourceName }), "googleConnected");
        await maybeYield();
      }
    }
  }

  if (sources.includes("number_change")) {
    const changes = await repository.listIdentityNumberChanges({ limit: Math.max(1, options.maxNumberChanges ?? 10_000) });
    for (const change of changes) {
      count(
        await repository.connectIdentities(change.oldJid, change.newJid, "number_change", { eventKey: change.eventKey }),
        "numberChangeConnected"
      );
      await maybeYield();
    }
  }

  recordAutoConnectRun(summary);
  return summary;
}
