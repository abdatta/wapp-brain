import type {
  ChatMetadataHistoryRecord,
  GroupMembershipEventRecord,
  IdentityNumberChangeRecord,
  MessageDetail,
  MessageEditRevisionRecord,
  MessageStructuredSignalSummary,
  MessageStructuredSignals,
  MessageSystemEventSummary
} from "../../shared/types";

interface EditEventForTimeline {
  timestampMs: number | null;
  source: "backup" | "live";
  sourceEventKey: string | null;
}

// Revision rows hold the content that was replaced by an edit. Edit-event
// rows prove that a transition happened but may not hold the prior text. Build
// the owner-facing timeline from those facts without ever presenting current
// text as the original or reusing the send time as an edit time.
export function buildMessageEditTimeline(input: {
  sentAtMs: number | null;
  currentText: string | null;
  revisions: MessageEditRevisionRecord[];
  events: EditEventForTimeline[];
}): MessageDetail["editTimeline"] {
  const revisions = [...input.revisions].sort((left, right) => left.revisionIndex - right.revisionIndex);
  const rawEvents = [...input.events].sort((left, right) => (left.timestampMs ?? Number.MAX_SAFE_INTEGER) - (right.timestampMs ?? Number.MAX_SAFE_INTEGER));
  if (revisions.length === 0 && rawEvents.length === 0) return [];

  const events = rawEvents.map((event) => ({
    ...event,
    // Historical live envelopes from older Baileys integrations sometimes
    // copied the original message time onto the edit update. The edit remains
    // proven, but that value is not an honest edit time.
    timestampMs: input.sentAtMs != null && event.timestampMs === input.sentAtMs
      ? null
      : event.timestampMs
  }));

  const knownTimes = [
    ...events.map((event) => event.timestampMs),
    ...revisions.map((revision) => revision.editedAtMs)
  ].filter((value): value is number => value != null && Number.isFinite(value));
  const latestEditAtMs = knownTimes.length ? Math.max(...knownTimes) : null;
  const earliestRevisionText = revisions[0] ? revisions[0].body ?? revisions[0].caption ?? null : null;
  const timeline: MessageDetail["editTimeline"] = [{
    kind: "sent",
    timestampMs: input.sentAtMs,
    text: earliestRevisionText,
    source: "archive",
    sourceEventKey: null
  }];

  // With N retained pre-edit snapshots, snapshot 0 is the original and each
  // later snapshot is the content that became active at the prior edit time.
  for (let index = 1; index < revisions.length; index += 1) {
    timeline.push({
      kind: "held_revision",
      timestampMs: revisions[index - 1]!.editedAtMs,
      text: revisions[index]!.body ?? revisions[index]!.caption ?? null,
      source: "archive",
      sourceEventKey: null
    });
  }

  const representedTimes = new Set(timeline.map((entry) => entry.timestampMs).filter((value): value is number => value != null));
  for (const event of events) {
    if (event.timestampMs == null || event.timestampMs === latestEditAtMs || representedTimes.has(event.timestampMs)) continue;
    timeline.push({
      kind: "metadata_only_edit",
      timestampMs: event.timestampMs,
      text: null,
      source: event.source,
      sourceEventKey: event.sourceEventKey
    });
    representedTimes.add(event.timestampMs);
  }

  const latestEvent = [...events].reverse().find((event) => event.timestampMs === latestEditAtMs) ?? null;
  timeline.push({
    kind: "current",
    timestampMs: latestEditAtMs,
    text: input.currentText,
    source: latestEvent?.source ?? "archive",
    sourceEventKey: latestEvent?.sourceEventKey ?? null
  });
  return timeline.sort((left, right) => (left.timestampMs ?? Number.MAX_SAFE_INTEGER) - (right.timestampMs ?? Number.MAX_SAFE_INTEGER));
}

// The thread/list projection intentionally removes the sensitive portions of
// captured source signals. Evidence assembly reads full local records; HTTP
// list payloads get only this bounded summary plus availability flags.
export function summarizeStructuredSignals(signals: MessageStructuredSignals | null): MessageStructuredSignalSummary | null {
  if (!signals) return null;
  const hasLocation = Boolean(signals.location);
  const vcardCount = signals.vcards.length;
  const hasDeletion = Boolean(signals.deletion);
  const hasEditHistory = Boolean(signals.edit);
  const hasSourceInterpretation = signals.mediaInterpretations.length > 0;
  return {
    mentionCount: signals.mentionedJids.length,
    location: signals.location
      ? { name: signals.location.name, address: signals.location.address, isLive: signals.location.isLive }
      : null,
    vcards: signals.vcards.map((card) => ({ displayName: card.displayName })),
    deletion: signals.deletion ? { revokedAtMs: signals.deletion.revokedAtMs } : null,
    edit: signals.edit,
    mediaInterpretations: signals.mediaInterpretations.map((interpretation) => ({
      kind: interpretation.kind,
      segmentIndex: interpretation.segmentIndex,
      hasText: Boolean(interpretation.text)
    })),
    captureVersion: signals.captureVersion,
    detailAvailability: {
      hasLocation,
      vcardCount,
      hasDeletion,
      hasEditHistory,
      hasSourceInterpretation,
      hasSystemEventDetail: false
    }
  };
}

interface SystemEventSummaryInput {
  numberChanges: IdentityNumberChangeRecord[];
  membershipEvents: GroupMembershipEventRecord[];
  chatMetadataHistory: ChatMetadataHistoryRecord[];
  // Repositories resolve only saved/push names (and the explicit owner token)
  // here. A missing role never falls back to the message sender, group JID, or
  // archive owner.
  displayNameForJid: (jid: string | null) => string | null;
}

// One serializer for both adapters. The source model carries actor and
// affected roles separately; this function is deliberately mechanical so an
// unresolved actor can never become "You" by accident.
export function summarizeSystemEvents(input: SystemEventSummaryInput): MessageSystemEventSummary[] {
  const events: Array<MessageSystemEventSummary & { sortKey: string }> = [];
  const unknown = "Unknown";
  for (const record of input.numberChanges) {
    const subject = input.displayNameForJid(record.newJid) ?? input.displayNameForJid(record.oldJid) ?? unknown;
    events.push({
      kind: "number_change",
      summary: `${subject} changed their phone number.`,
      captureVersion: record.captureVersion,
      sortKey: `0:${record.eventKey}`
    });
  }
  for (const record of input.membershipEvents) {
    const participant = input.displayNameForJid(record.participantJid) ?? unknown;
    const actor = input.displayNameForJid(record.actorJid) ?? unknown;
    const isSelfAction = record.actorJid != null && record.actorJid === record.participantJid;
    let summary: string;
    switch (record.action) {
      case "join": summary = `${participant} joined the group.`; break;
      case "leave": summary = `${participant} left the group.`; break;
      case "add": summary = isSelfAction ? `${participant} joined the group.` : `${actor} added ${participant} to the group.`; break;
      case "remove": summary = isSelfAction ? `${participant} left the group.` : `${actor} removed ${participant} from the group.`; break;
      case "invite": summary = `${actor} invited ${participant} to the group.`; break;
      case "accept": summary = `${participant} accepted the group invitation.`; break;
      case "promote": summary = `${actor} made ${participant} a group admin.`; break;
      case "demote": summary = `${actor} removed ${participant} as a group admin.`; break;
    }
    events.push({ kind: "membership", summary, captureVersion: record.captureVersion, sortKey: `1:${record.eventKey}` });
  }
  for (const record of input.chatMetadataHistory) {
    const actor = input.displayNameForJid(record.actorJid) ?? unknown;
    const subject = boundedDisplayText(record.newValue);
    let summary: string;
    switch (record.field) {
      case "subject": summary = subject ? `${actor} changed the group subject to \u201C${subject}\u201D.` : `${actor} changed the group subject.`; break;
      case "description": summary = `${actor} changed the group description.`; break;
      case "photo": summary = `${actor} changed the group photo.`; break;
      case "invite_link": summary = `${actor} changed the group invite link.`; break;
      case "announcement": summary = `${actor} changed who can send messages.`; break;
      case "restriction": summary = `${actor} changed group editing permissions.`; break;
      case "member_add": summary = `${actor} changed who can add members.`; break;
      case "join_approval": summary = `${actor} changed join approval.`; break;
      case "disappearing": summary = `${actor} changed disappearing messages.`; break;
    }
    events.push({ kind: "chat_metadata", summary, captureVersion: record.captureVersion, sortKey: `2:${record.eventKey}` });
  }
  return events.sort((left, right) => left.sortKey.localeCompare(right.sortKey)).map(({ sortKey: _sortKey, ...event }) => event);
}

function boundedDisplayText(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return !compact ? null : compact.length <= 120 ? compact : `${compact.slice(0, 117).trimEnd()}...`;
}
