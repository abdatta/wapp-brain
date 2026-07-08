import { createHash } from "node:crypto";
import { decryptEventResponse, decryptPollVote } from "@whiskeysockets/baileys";
import type { RetainedPayloadRecord } from "../../shared/types";
import type { ArchiveRepository } from "../db/repository";
import { messageKey } from "../identity/keys";

// Late decryption of retained secret-encrypted payloads: whenever the missing
// half arrives (secret learned from a backup or live envelope, or a payload
// arriving for an armed message), decrypt and apply the result as a normal
// targeted state update. What cannot be decrypted stays retained and honestly
// labeled. The HKDF binds the exact jid strings the sender used, so a payload
// whose actors we only know in a different identity form fails closed and
// remains retained — never mislabeled.
//
// Kinds: poll_vote and event_response have first-class Baileys decryptors;
// secret_encrypted (message/event edits) has no public decryptor yet and is
// retained until one exists.

export interface SecretsPassResult {
  attempted: number;
  decrypted: number;
}

export async function runRetainedPayloadDecryptionPass(
  repository: ArchiveRepository,
  options: { meJid?: string | null; limit?: number } = {}
): Promise<SecretsPassResult> {
  const payloads = await repository.listRetainedEncryptedPayloads(options.limit ?? 200);
  let attempted = 0;
  let decrypted = 0;
  for (const payload of payloads) {
    if (payload.kind === "secret_encrypted") {
      continue;
    }
    attempted += 1;
    const update = await tryDecryptRetainedPayload(repository, payload, options.meJid ?? null);
    if (!update) {
      continue;
    }
    await repository.applyLiveMessageUpdates([update]);
    if (payload.id != null) {
      await repository.deleteRetainedEncryptedPayload(payload.id);
    }
    decrypted += 1;
  }
  return { attempted, decrypted };
}

type TargetedUpdate = Parameters<ArchiveRepository["applyLiveMessageUpdates"]>[0][number];

async function tryDecryptRetainedPayload(
  repository: ArchiveRepository,
  payload: RetainedPayloadRecord,
  meJid: string | null
): Promise<TargetedUpdate | null> {
  const secret = await repository.getMessageSecret(payload.chatSourceId, payload.targetMessageId);
  if (!secret) {
    return null;
  }
  const context = await repository.getMessageInterpretationContext(payload.chatSourceId, payload.targetMessageId);
  if (!context) {
    return null;
  }
  const creatorJid = resolveProtocolJid(
    context.fromMe ? "me" : context.senderSourceJid,
    meJid,
    payload.chatSourceId
  );
  const rawActorJid = typeof payload.metadata?.rawActorJid === "string" ? payload.metadata.rawActorJid : null;
  const actorForMetadata = payload.actorJid;
  const actorCandidates = [rawActorJid, resolveProtocolJid(payload.actorJid, meJid, payload.chatSourceId)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  if (!creatorJid || actorCandidates.length === 0) {
    return null;
  }
  for (const voterJid of actorCandidates) {
    try {
      if (payload.kind === "poll_vote") {
        const vote = decryptPollVote(
          { encPayload: payload.encPayload, encIv: payload.encIv ?? undefined },
          {
            pollCreatorJid: creatorJid,
            pollMsgId: payload.targetMessageId,
            pollEncKey: secret,
            voterJid
          }
        );
        const optionNames = matchSelectedOptions(vote.selectedOptions ?? [], context.rawMetadata);
        return {
          eventKey: `decrypted:${payload.eventKey}`,
          chatSourceId: payload.chatSourceId,
          sourceMessageKey: targetKeyOf(payload),
          updateType: "poll_vote",
          occurredAtMs: payload.occurredAtMs,
          metadata: { voterJid: actorForMetadata, options: optionNames }
        };
      }
      if (payload.kind === "event_response") {
        const response = decryptEventResponse(
          { encPayload: payload.encPayload, encIv: payload.encIv ?? undefined },
          {
            eventCreatorJid: creatorJid,
            eventMsgId: payload.targetMessageId,
            eventEncKey: secret,
            responderJid: voterJid
          }
        );
        return {
          eventKey: `decrypted:${payload.eventKey}`,
          chatSourceId: payload.chatSourceId,
          sourceMessageKey: targetKeyOf(payload),
          updateType: "event_response",
          occurredAtMs: payload.occurredAtMs,
          metadata: {
            responderJid: actorForMetadata,
            response: response.response == null ? null : Number(response.response),
            extraGuestCount: response.extraGuestCount ?? null
          }
        };
      }
    } catch {
      // Wrong identity form or corrupt payload — try the next candidate;
      // ultimately the payload stays retained.
    }
  }
  return null;
}

// Decryption needs real jid strings; archived "me" resolves through the
// linked-device jid when known.
function resolveProtocolJid(actor: string | null | undefined, meJid: string | null, chatSourceId: string): string | null {
  if (!actor) {
    return null;
  }
  if (actor === "me") {
    return meJid;
  }
  if (actor === chatSourceId && chatSourceId.endsWith("@g.us")) {
    return null;
  }
  return actor;
}

// Decrypted poll votes carry sha256(optionName); match against the poll's
// archived option names.
function matchSelectedOptions(selected: Uint8Array[], rawMetadata: Record<string, unknown> | null): string[] {
  const poll = rawMetadata?.poll as { options?: Array<{ name?: unknown }> } | undefined;
  const names = (poll?.options ?? [])
    .map((option) => (typeof option?.name === "string" ? option.name : null))
    .filter((name): name is string => name !== null);
  const byHash = new Map(names.map((name) => [createHash("sha256").update(name).digest("hex"), name]));
  return selected
    .map((hash) => byHash.get(Buffer.from(hash).toString("hex")))
    .filter((name): name is string => Boolean(name));
}

function targetKeyOf(payload: RetainedPayloadRecord): string {
  return messageKey(payload.chatSourceId, payload.targetMessageId);
}
