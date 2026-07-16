import type { ArchiveRepository } from "../db/repository";
import type { IdentityProfile, PersonSuggestionInput } from "../../shared/types";
import { isMaskedNumberLabel } from "../import/jid";
import { recordDetectorRun } from "./scanStatus";

// Deterministic person-link suggestion detectors. Detectors PRODUCE, never
// apply: ranked rows with inspectable evidence land in person_suggestions and
// only an explicit user acceptance connects. The repository upsert enforces
// the negative memory (skips co-members and suppressed pairs, never
// resurrects a rejected row), so a detector re-run over unchanged or
// strengthened evidence can never nag. Passes are bounded full recomputes
// from state — safe to interrupt anywhere, cheap at recovery-tick cadence —
// and nothing here ever groups identities by name; a name collision only
// ever becomes a suggestion.

export type PersonDetectorKind = "same_name" | "shared_group" | "co_citation" | "succession" | "shared_vcard";

export interface PersonDetectorOptions {
  detectors?: PersonDetectorKind[];
  // Bounds (runaway guards; real archives sit well inside them).
  maxIdentities?: number;
  maxGroups?: number;
  maxGroupSizeForPairs?: number;
  maxSuggestionsPerDetector?: number;
  // Succession tuning: how long after A's silence B may first appear, the
  // per-pair overlap tolerance, and how many enders/starters to consider.
  successionWindowMs?: number;
  successionOverlapToleranceMs?: number;
  successionCandidates?: number;
}

export interface PersonDetectorSummary {
  created: number;
  updated: number;
  byDetector: Record<string, number>;
  // Pending pairs pruned because neither side has any sent message — no
  // unifiable history, nothing to disambiguate. They resurrect on their own
  // once either number speaks.
  prunedZeroValue: number;
  // Pending pairs pruned because they are already resolved: both sides are
  // co-members of one person (connected directly or transitively — e.g. a
  // three-number Google card connects A↔B and A↔C, leaving a stale B↔C
  // suggestion) or the pair is suppressed by a disconnect.
  prunedResolved: number;
}

interface LabeledIdentity {
  jid: string;
  label: string;
  labelSource: "saved" | "push";
  messageCount: number;
}

function genuineLabel(profile: IdentityProfile): { label: string; source: "saved" | "push" } | null {
  const saved = profile.displayName?.trim();
  if (saved && !isMaskedNumberLabel(saved) && !isDigitsOnlyRestatement(saved, profile.jid)) {
    return { label: saved, source: "saved" };
  }
  const push = profile.pushName?.trim();
  if (push && !isMaskedNumberLabel(push) && !isDigitsOnlyRestatement(push, profile.jid)) {
    return { label: push, source: "push" };
  }
  return null;
}

// A "name" that just restates the identity's digits is not a name; grouping
// on it would pair unrelated unsaved contacts.
function isDigitsOnlyRestatement(name: string, jid: string): boolean {
  const digits = name.replace(/\D/g, "");
  const localPart = jid.split("@")[0] ?? "";
  return digits.length > 0 && name.replace(/[\s+\-()]/g, "") === digits && (digits === localPart || localPart.endsWith(digits));
}

export async function runPersonSuggestionDetectors(
  repository: ArchiveRepository,
  options: PersonDetectorOptions = {}
): Promise<PersonDetectorSummary> {
  // shared_group is deliberately NOT a default producer: real-data feedback
  // showed standalone co-presence pairs are mostly noise (two people active
  // in the same group at the same time are usually different people). Group
  // co-presence survives only as corroborating evidence inside succession.
  const detectors = options.detectors ?? ["same_name", "shared_vcard", "co_citation", "succession"];
  const cap = Math.max(1, options.maxSuggestionsPerDetector ?? 50);
  const summary: PersonDetectorSummary = { created: 0, updated: 0, byDetector: {}, prunedZeroValue: 0, prunedResolved: 0 };
  const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  // Clean up pending rows from the retired standalone detector so they stop
  // cluttering the queue (rejected/accepted history is preserved untouched).
  if (!detectors.includes("shared_group")) {
    await repository.supersedePersonSuggestionsByKind("shared_group");
  }

  // Queue hygiene over the pending rows:
  // 1. Already-resolved pairs — both sides co-members of one person
  //    (connects supersede only the directly-connected pair, so a
  //    three-number card leaves stale transitive pairs behind) or a pair
  //    suppressed by a disconnect.
  // 2. Zero-value pairs — neither side has ever sent a message: nothing to
  //    unify, nothing to disambiguate.
  // Superseded rows resurrect through the upsert if a detector produces the
  // pair afresh (co-member/suppressed pairs are skipped there, so resolved
  // ones stay quiet while resolved; zero-value ones return once a number
  // speaks), so nothing is lost.
  const pending = await repository.listPersonSuggestions({ status: "pending", limit: 1_000 });
  if (pending.length > 0) {
    const personKeys = await repository.personKeyForJids([...new Set(pending.flatMap((suggestion) => [suggestion.jidLow, suggestion.jidHigh]))]);
    const suppressions = await repository.listPersonLinkSuppressions(1_000);
    const suppressedPairs = new Set(suppressions.map((row) => `${row.jidLow}|${row.jidHigh}`));
    const resolvedIds = pending
      .filter(
        (suggestion) =>
          personKeys.get(suggestion.jidLow) === personKeys.get(suggestion.jidHigh) ||
          suppressedPairs.has(`${suggestion.jidLow}|${suggestion.jidHigh}`)
      )
      .map((suggestion) => suggestion.id);
    if (resolvedIds.length > 0) {
      summary.prunedResolved = await repository.supersedePersonSuggestionsByIds(resolvedIds);
    }
    const resolvedSet = new Set(resolvedIds);
    const zeroValueIds = pending
      .filter((suggestion) => !resolvedSet.has(suggestion.id))
      .filter((suggestion) => (suggestion.lowMessageCount ?? 0) === 0 && (suggestion.highMessageCount ?? 0) === 0)
      .map((suggestion) => suggestion.id);
    if (zeroValueIds.length > 0) {
      summary.prunedZeroValue = await repository.supersedePersonSuggestionsByIds(zeroValueIds);
    }
  }

  // Shared inputs for the label-driven detectors.
  const needsProfiles = detectors.includes("same_name") || detectors.includes("shared_vcard");
  const profiles = needsProfiles ? await repository.listIdentityProfiles({ limit: options.maxIdentities ?? 10_000 }) : [];
  const labeled: LabeledIdentity[] = [];
  for (const profile of profiles) {
    const label = genuineLabel(profile);
    if (label) {
      labeled.push({ jid: profile.jid, label: label.label, labelSource: label.source, messageCount: profile.messageCount });
    }
  }

  const apply = async (kind: PersonDetectorKind, suggestions: PersonSuggestionInput[]): Promise<void> => {
    const bounded = suggestions.sort((a, b) => b.score - a.score).slice(0, cap);
    const result = await repository.upsertPersonSuggestions(bounded);
    summary.created += result.created;
    summary.updated += result.updated;
    summary.byDetector[kind] = (summary.byDetector[kind] ?? 0) + result.created + result.updated;
    await yieldNow();
  };

  if (detectors.includes("same_name")) {
    const byLabel = new Map<string, LabeledIdentity[]>();
    for (const identity of labeled) {
      const key = identity.label.toLowerCase();
      byLabel.set(key, [...(byLabel.get(key) ?? []), identity]);
    }
    const suggestions: PersonSuggestionInput[] = [];
    for (const identities of byLabel.values()) {
      // A label shared by many identities ("Mom", a business name) is noise,
      // not a person signal.
      if (identities.length < 2 || identities.length > 6) {
        continue;
      }
      for (let i = 0; i < identities.length; i += 1) {
        for (let j = i + 1; j < identities.length; j += 1) {
          const [a, b] = [identities[i], identities[j]];
          // A merge's unified value is bounded by the smaller side: when
          // NEITHER side has ever sent a message, deciding the pair has no
          // observable payoff today. Skip it — detectors recompute from
          // state, so the pair surfaces by itself once either number speaks.
          if (a.messageCount === 0 && b.messageCount === 0) {
            continue;
          }
          const score = a.labelSource === "saved" && b.labelSource === "saved" ? 0.85 : a.labelSource === "saved" || b.labelSource === "saved" ? 0.7 : 0.6;
          suggestions.push({
            jidA: a.jid,
            jidB: b.jid,
            kind: "same_name",
            score,
            evidence: {
              name: a.label,
              labelSources: { [a.jid]: a.labelSource, [b.jid]: b.labelSource },
              messageCounts: { [a.jid]: a.messageCount, [b.jid]: b.messageCount }
            }
          });
        }
      }
    }
    await apply("same_name", suggestions);
  }

  if (detectors.includes("shared_vcard")) {
    const vcards = await repository.listResolvedVcardNames({ limit: 1_000 });
    const messagesByJid = new Map(profiles.map((profile) => [profile.jid, profile.messageCount]));
    const byLabel = new Map<string, LabeledIdentity[]>();
    for (const identity of labeled) {
      const key = identity.label.toLowerCase();
      byLabel.set(key, [...(byLabel.get(key) ?? []), identity]);
    }
    const suggestions: PersonSuggestionInput[] = [];
    for (const vcard of vcards) {
      const cardName = vcard.displayName?.trim();
      if (!cardName || isMaskedNumberLabel(cardName)) {
        continue;
      }
      // A shared contact card asserts "this name maps to this number"; when a
      // DIFFERENT archived identity already carries that name, the card is a
      // weak corroborating link between the two.
      for (const identity of byLabel.get(cardName.toLowerCase()) ?? []) {
        // Same zero-value rule as same_name: skip when neither side has
        // ever sent a message.
        if (identity.messageCount === 0 && (messagesByJid.get(vcard.resolvedJid) ?? 0) === 0) {
          continue;
        }
        if (identity.jid !== vcard.resolvedJid) {
          suggestions.push({
            jidA: vcard.resolvedJid,
            jidB: identity.jid,
            kind: "shared_vcard",
            score: 0.5,
            evidence: { vcardName: cardName, resolvedJid: vcard.resolvedJid, namedIdentity: identity.jid }
          });
        }
      }
    }
    await apply("shared_vcard", suggestions);
  }

  if (detectors.includes("shared_group")) {
    const sets = await repository.listGroupParticipantSets({
      maxGroupSize: options.maxGroupSizeForPairs ?? 16,
      limit: options.maxGroups ?? 500
    });
    const pairStats = new Map<string, { jidA: string; jidB: string; sharedGroups: string[]; weight: number }>();
    for (const set of sets) {
      const members = [...new Set(set.participantJids)].sort();
      const weight = 1 / Math.max(1, members.length - 1);
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const key = `${members[i]} ${members[j]}`;
          const entry = pairStats.get(key) ?? { jidA: members[i], jidB: members[j], sharedGroups: [], weight: 0 };
          entry.sharedGroups.push(set.groupSourceId);
          entry.weight += weight;
          pairStats.set(key, entry);
        }
      }
    }
    const suggestions: PersonSuggestionInput[] = [];
    for (const entry of pairStats.values()) {
      // Co-presence is common among genuinely different people; only heavy
      // small-group overlap is worth surfacing, and only at a low score.
      if (entry.sharedGroups.length < 3) {
        continue;
      }
      suggestions.push({
        jidA: entry.jidA,
        jidB: entry.jidB,
        kind: "shared_group",
        score: Math.min(0.6, 0.3 + 0.05 * entry.sharedGroups.length + Math.min(0.1, entry.weight * 0.05)),
        evidence: { sharedGroups: entry.sharedGroups.slice(0, 5), sharedGroupCount: entry.sharedGroups.length }
      });
    }
    await apply("shared_group", suggestions);
  }

  if (detectors.includes("co_citation")) {
    const pairs = await repository.listCoCitedIdentityPairs({ minEpisodes: 2, limit: 200 });
    await apply(
      "co_citation",
      pairs.map((pair) => ({
        jidA: pair.jidA,
        jidB: pair.jidB,
        kind: "co_citation" as const,
        score: Math.min(0.65, 0.3 + 0.1 * pair.episodes),
        evidence: { coCitedEpisodes: pair.episodes }
      }))
    );
  }

  if (detectors.includes("succession")) {
    await apply("succession", await detectSuccession(repository, options));
  }

  recordDetectorRun({ created: summary.created, updated: summary.updated });
  return summary;
}

// The succession pattern: number A goes silent, and number B first appears —
// in the same chats — within a bounded window. Sharpened by the group
// membership timeline when a leave/join handoff exists. Evidence names the
// shared chats and both windows so a human can check the claim.
async function detectSuccession(repository: ArchiveRepository, options: PersonDetectorOptions): Promise<PersonSuggestionInput[]> {
  const windowMs = options.successionWindowMs ?? 60 * 24 * 60 * 60_000;
  const overlapToleranceMs = options.successionOverlapToleranceMs ?? 7 * 24 * 60 * 60_000;
  const candidateCap = Math.max(10, options.successionCandidates ?? 200);
  const summaries = await repository.listIdentityActivitySummaries({ minMessages: 5, limit: 2_000 });
  const usable = summaries.filter((summary) => summary.firstMs != null && summary.lastMs != null);
  if (usable.length < 2) {
    return [];
  }
  // Candidate enders (most recently silent first) and starters (most recently
  // appeared first), bounded so the pair scan stays small.
  const enders = [...usable].sort((a, b) => (b.lastMs ?? 0) - (a.lastMs ?? 0)).slice(0, candidateCap);
  const starters = [...usable].sort((a, b) => (b.firstMs ?? 0) - (a.firstMs ?? 0)).slice(0, candidateCap);
  const candidatePairs: Array<{ ender: (typeof usable)[number]; starter: (typeof usable)[number] }> = [];
  for (const ender of enders) {
    for (const starter of starters) {
      if (ender.jid === starter.jid) {
        continue;
      }
      const gap = (starter.firstMs ?? 0) - (ender.lastMs ?? 0);
      if (gap >= -overlapToleranceMs && gap <= windowMs) {
        candidatePairs.push({ ender, starter });
      }
    }
  }
  if (candidatePairs.length === 0) {
    return [];
  }
  const involved = [...new Set(candidatePairs.flatMap((pair) => [pair.ender.jid, pair.starter.jid]))];
  const activity = await repository.listIdentityChatActivity(involved);
  const byJid = new Map<string, Map<string, { firstMs: number | null; lastMs: number | null }>>();
  for (const row of activity) {
    const chats = byJid.get(row.jid) ?? new Map();
    chats.set(row.chatSourceId, { firstMs: row.firstMs, lastMs: row.lastMs });
    byJid.set(row.jid, chats);
  }
  const suggestions: PersonSuggestionInput[] = [];
  for (const { ender, starter } of candidatePairs) {
    const enderChats = byJid.get(ender.jid);
    const starterChats = byJid.get(starter.jid);
    if (!enderChats || !starterChats) {
      continue;
    }
    // Shared chats where A's activity ends before B's begins (per-chat, with
    // the same overlap tolerance). DM chats keyed by counterparty JID never
    // coincide for two different numbers, so shared chats are groups.
    const handoffChats: string[] = [];
    for (const [chatSourceId, enderWindow] of enderChats) {
      const starterWindow = starterChats.get(chatSourceId);
      if (!starterWindow || enderWindow.lastMs == null || starterWindow.firstMs == null) {
        continue;
      }
      if (starterWindow.firstMs >= enderWindow.lastMs - overlapToleranceMs) {
        handoffChats.push(chatSourceId);
      }
    }
    if (handoffChats.length < 2) {
      continue;
    }
    // Membership-timeline sharpening: an explicit leave/join handoff in one
    // of the shared groups within the window.
    let membershipHandoffGroups: string[] = [];
    try {
      const [enderPeriods, starterPeriods] = await Promise.all([
        repository.listGroupMembershipPeriods({ participantJid: ender.jid, limit: 200 }),
        repository.listGroupMembershipPeriods({ participantJid: starter.jid, limit: 200 })
      ]);
      const joinsByGroup = new Map<string, number[]>();
      for (const period of starterPeriods) {
        if (period.joinedAtMs != null) {
          joinsByGroup.set(period.groupSourceId, [...(joinsByGroup.get(period.groupSourceId) ?? []), period.joinedAtMs]);
        }
      }
      membershipHandoffGroups = [
        ...new Set(
          enderPeriods
            .filter((period) => period.leftAtMs != null)
            .filter((period) =>
              (joinsByGroup.get(period.groupSourceId) ?? []).some(
                (joinedAtMs) => joinedAtMs >= period.leftAtMs! - overlapToleranceMs && joinedAtMs - period.leftAtMs! <= windowMs
              )
            )
            .map((period) => period.groupSourceId)
        )
      ];
    } catch {
      // Membership sharpening is best-effort; the message-level signal stands.
    }
    const score = Math.min(0.9, 0.5 + 0.1 * Math.min(3, handoffChats.length) + (membershipHandoffGroups.length > 0 ? 0.15 : 0));
    suggestions.push({
      jidA: ender.jid,
      jidB: starter.jid,
      kind: "succession",
      score,
      evidence: {
        // The pair is stored low/high-normalized, so the evidence records
        // which side went silent and which appeared.
        enderJid: ender.jid,
        starterJid: starter.jid,
        sharedChats: handoffChats.slice(0, 5),
        sharedChatCount: handoffChats.length,
        enderLastMs: ender.lastMs,
        starterFirstMs: starter.firstMs,
        gapMs: (starter.firstMs ?? 0) - (ender.lastMs ?? 0),
        ...(membershipHandoffGroups.length > 0 ? { membershipHandoffGroups: membershipHandoffGroups.slice(0, 5) } : {})
      }
    });
  }
  return suggestions;
}
