// Poll votes and event responses apply to their target message as per-actor
// records inside rawMetadata (poll.votes / event.responses), newest-wins per
// actor. Both repositories and both sources (backup add-ons, decrypted live
// updates) converge through this one merge so downstream consumers read one
// shape.

interface TargetedInteractionUpdate {
  updateType: string;
  occurredAtMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export function mergeInteractionMetadata(
  metadata: Record<string, unknown>,
  update: TargetedInteractionUpdate
): Record<string, unknown> | null {
  if (update.updateType === "poll_vote") {
    const voterJid = stringOrNullValue(update.metadata?.voterJid);
    const options = Array.isArray(update.metadata?.options)
      ? (update.metadata?.options as unknown[]).map((option) => String(option))
      : [];
    return mergeActorRecord(metadata, "poll", "votes", "voterJid", voterJid, {
      voterJid,
      options,
      atMs: update.occurredAtMs ?? null
    });
  }
  if (update.updateType === "event_response") {
    const responderJid = stringOrNullValue(update.metadata?.responderJid);
    return mergeActorRecord(metadata, "event", "responses", "responderJid", responderJid, {
      responderJid,
      response: update.metadata?.response ?? null,
      extraGuestCount: update.metadata?.extraGuestCount ?? null,
      atMs: update.occurredAtMs ?? null
    });
  }
  return null;
}

function mergeActorRecord(
  metadata: Record<string, unknown>,
  sectionKey: string,
  listKey: string,
  actorField: string,
  actorJid: string | null,
  record: Record<string, unknown>
): Record<string, unknown> | null {
  const section = { ...((metadata[sectionKey] as Record<string, unknown> | undefined) ?? {}) };
  const list = Array.isArray(section[listKey]) ? [...(section[listKey] as Array<Record<string, unknown>>)] : [];
  const index = list.findIndex((entry) => ((entry?.[actorField] as string | null) ?? null) === actorJid);
  if (index >= 0) {
    const existingAt = typeof list[index]?.atMs === "number" ? (list[index].atMs as number) : 0;
    const incomingAt = typeof record.atMs === "number" ? (record.atMs as number) : 0;
    if (existingAt > incomingAt) {
      // The archive already holds newer state for this actor.
      return null;
    }
    list[index] = record;
  } else {
    list.push(record);
  }
  return { ...metadata, [sectionKey]: { ...section, [listKey]: list } };
}

function stringOrNullValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
