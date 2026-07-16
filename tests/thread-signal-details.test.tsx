import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArchiveSignalObservation, MessageDetail, MessageListItem } from "../src/shared/types";
import {
  MessageBubble,
  MessageDetailContent,
  editHistoryPresentation,
  formatDetailDateTime,
  groupConsecutiveMedia,
  messageDetailSubtitle,
  messageDetailTitle,
  visibleMessageText
} from "../src/client/thread";

const sentAtMs = Date.parse("2026-07-02T16:21:10.000Z");
const editedAtMs = Date.parse("2026-07-02T16:36:42.000Z");
const deletedAtMs = sentAtMs + 16_000;

function observation(family: ArchiveSignalObservation["family"], key: string): ArchiveSignalObservation {
  return {
    factKey: `fact:${key}`,
    family,
    sourceMessageKey: "message:synthetic",
    detailJson: null,
    source: "backup",
    sourceEventKey: key,
    observedAtMs: sentAtMs,
    captureVersion: 1
  };
}

const detail: MessageDetail = {
  id: 42,
  sourceMessageKey: "message:synthetic",
  sentAtMs,
  availability: {
    hasLocation: true,
    vcardCount: 1,
    hasDeletion: true,
    hasEditHistory: true,
    hasSourceInterpretation: true,
    hasSystemEventDetail: true
  },
  locations: [{
    sourceMessageKey: "message:synthetic",
    latitude: 34.0689,
    longitude: -118.4452,
    name: "Powell Library",
    address: "Los Angeles, CA",
    isLive: true,
    accuracyMeters: 8,
    url: "https://maps.example.test/location",
    comment: "Meet here",
    caption: null,
    speedMps: 0,
    headingDegrees: 180,
    sequenceNumber: 123,
    timeOffsetMs: 5_000,
    liveShareDurationMs: 60_000,
    finalAtMs: sentAtMs + 60_000,
    hasThumbnail: false,
    source: "backup",
    sourceEventKey: "location:1",
    observedAtMs: sentAtMs,
    captureVersion: 1,
    observations: [],
    provenance: [observation("location", "location:1")]
  }],
  vcards: [{
    sourceMessageKey: "message:synthetic",
    cardIndex: 0,
    displayName: "Avery Example",
    vcard: "BEGIN:VCARD\nFN:Avery Example\nTEL:+15550001111\nEND:VCARD",
    resolvedJid: "15550001111@s.whatsapp.net",
    properties: [{ name: "TEL", group: null, parameters: [{ name: "TYPE", values: ["CELL"] }], value: "+15550001111" }],
    downloadKind: "source",
    downloadFileName: "Avery Example.vcf",
    source: "backup",
    sourceEventKey: "vcard:1",
    observedAtMs: sentAtMs,
    captureVersion: 1,
    provenance: [observation("vcard", "vcard:1")]
  }],
  mentionedJids: ["15550002222@s.whatsapp.net"],
  editTimeline: [
    { kind: "sent", timestampMs: sentAtMs, text: null, source: "archive", sourceEventKey: null },
    { kind: "metadata_only_edit", timestampMs: editedAtMs, text: null, source: "backup", sourceEventKey: "edit:1" },
    { kind: "current", timestampMs: editedAtMs, text: "Current edited text", source: "backup", sourceEventKey: "edit:1" }
  ],
  deletion: {
    revokedByJid: null,
    revokedByAdmin: false,
    deletionKind: "sender_revoke",
    deletedAtMs,
    sentAtMs,
    contentState: "never_captured",
    observations: [observation("deletion", "deletion:1")]
  },
  mediaInterpretations: [{
    sourceMessageKey: "message:synthetic",
    kind: "transcription",
    segmentIndex: 0,
    text: "Meet me by the library entrance.",
    startMs: null,
    endMs: null,
    source: "backup",
    sourceEventKey: "transcript:1",
    observedAtMs: sentAtMs,
    captureVersion: 1
  }],
  linkPreview: null,
  systemEvents: [{
    kind: "generic",
    eventKey: "system:1",
    summary: "System event",
    actorJid: null,
    actorLabel: null,
    participantJid: null,
    participantLabel: null,
    oldJid: null,
    oldIdentityLabel: null,
    newJid: null,
    newIdentityLabel: null,
    oldValue: null,
    newValue: null,
    action: null,
    field: null,
    occurredAtMs: sentAtMs,
    rawType: "999",
    rawParameters: "{\"code\":999}",
    observations: [observation("chat_metadata", "system:1")]
  }]
};

function renderFocus(focus: Parameters<typeof MessageDetailContent>[0]["focus"]): string {
  return renderToStaticMarkup(createElement(MessageDetailContent, { detail, focus }));
}

function listMessage(overrides: Partial<MessageListItem> = {}): MessageListItem {
  return {
    id: 101,
    sourceMessageId: "synthetic-message",
    senderDisplayName: "Avery",
    senderSourceJid: "15550000001@s.whatsapp.net",
    timestampMs: sentAtMs,
    sentAt: new Date(sentAtMs).toISOString(),
    direction: "incoming",
    messageType: "text",
    interpretation: null,
    body: "hello",
    caption: null,
    mentions: [],
    hasMedia: false,
    mediaMimeType: null,
    mediaName: null,
    media: null,
    linkPreview: null,
    quotedSnapshot: null,
    isEdited: false,
    editRevisionCount: 0,
    isDeleted: false,
    isForwarded: false,
    isStarred: false,
    ...overrides
  };
}

describe("focused message detail presentation", () => {
  it("keeps every popup limited to the signal the user opened", () => {
    const system = renderFocus("system");
    expect(system).toContain("No join, leave, role, number-change");
    expect(system).not.toContain("Current edited text");
    expect(system).not.toContain("34.0689");
    expect(system).not.toContain("Meet me by the library");
    expect(system).not.toContain("Deletion source");

    const location = renderFocus("location");
    expect(location).toContain("34.0689");
    expect(location).toContain("Live share");
    expect(location).not.toContain("Current edited text");
    expect(location).not.toContain("Meet me by the library");
    expect(location).not.toContain("Deletion source");
    expect(location).not.toContain("System event");

    const deletion = renderFocus("deletion");
    expect(deletion).toContain("16 seconds later");
    expect(deletion).toContain("never captured the original message content");
    expect(deletion).not.toContain("Current edited text");
    expect(deletion).not.toContain("34.0689");
    expect(deletion).not.toContain("System event");

    const transcript = renderFocus("interpretation");
    expect(transcript).toContain("Meet me by the library entrance.");
    expect(transcript).toContain("Source-provided");
    expect(transcript).not.toContain("Current edited text");
    expect(transcript).not.toContain("34.0689");
    expect(transcript).not.toContain("Deletion source");

    const vcard = renderFocus("vcard");
    expect(vcard).toContain("Avery Example");
    expect(vcard).toContain("Download .vcf");
    expect(vcard).not.toContain("Current edited text");
    expect(vcard).not.toContain("34.0689");
    expect(vcard).not.toContain("Meet me by the library");
  });

  it("uses specific, honest titles and subtitles", () => {
    expect(messageDetailTitle(detail, "system")).toBe("Unclassified system event");
    expect(messageDetailTitle(detail, "location")).toBe("Live location");
    expect(messageDetailTitle(detail, "deletion")).toBe("Deleted message");
    expect(messageDetailTitle(detail, "vcard")).toBe("Shared contact");
    expect(messageDetailTitle(detail, "interpretation")).toBe("Transcript");
    expect(messageDetailSubtitle(detail, "system")).toContain("could not be decoded safely");
  });

  it("keeps send time and edit-record time separate without inventing original text", () => {
    expect(editHistoryPresentation(detail)).toEqual({
      sentAtMs,
      lastEditedMs: editedAtMs,
      originalTextMissing: true,
      hasDistinctTimes: true
    });
    const sent = formatDetailDateTime(sentAtMs);
    const edited = formatDetailDateTime(editedAtMs);
    expect(sent).not.toBe(edited);
    expect(sent).toMatch(/2026/);
    expect(sent).toMatch(/:\d{2}[^\d]*$/);
  });

  it("never substitutes sent time when the source lacks a trustworthy edit time", () => {
    const metadataOnly: MessageDetail = {
      ...detail,
      editTimeline: [
        { kind: "sent", timestampMs: sentAtMs, text: null, source: "archive", sourceEventKey: null },
        { kind: "metadata_only_edit", timestampMs: null, text: null, source: "backup", sourceEventKey: "edit:unknown-time" },
        { kind: "current", timestampMs: null, text: "Current edited text", source: "backup", sourceEventKey: "edit:unknown-time" }
      ]
    };
    expect(editHistoryPresentation(metadataOnly)).toEqual({
      sentAtMs,
      lastEditedMs: null,
      originalTextMissing: true,
      hasDistinctTimes: false
    });
  });

  it("replaces WhatsApp's generated contact count with the structured vCard control", () => {
    const message = listMessage({
      messageType: "contact",
      body: "2 contacts",
      structuredSignals: {
        mentionCount: 0,
        location: null,
        vcards: [{ displayName: "Steve" }, { displayName: "Zupermon" }],
        deletion: null,
        edit: null,
        mediaInterpretations: [],
        captureVersion: 1
      }
    });
    expect(visibleMessageText(message)).toBeNull();
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, isGroup: false, onOpenMedia: () => undefined }));
    expect(markup).toContain("2 contact cards");
    expect(markup).not.toContain(">2 contacts<");
    expect(markup).not.toContain("Contact card</p>");

    expect(visibleMessageText({ ...message, caption: "My actual caption" })).toBe("My actual caption");
    expect(visibleMessageText({ ...message, body: "Call either person" })).toBe("Call either person");
  });

  it("replaces the generated live-location label with the structured location control", () => {
    const message = listMessage({
      messageType: "live_location",
      body: null,
      interpretation: { label: "Live location", reason: null },
      structuredSignals: {
        mentionCount: 0,
        location: { name: null, address: null, isLive: true },
        vcards: [],
        deletion: null,
        edit: null,
        mediaInterpretations: [],
        captureVersion: 1
      }
    });
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, isGroup: false, onOpenMedia: () => undefined }));
    expect(markup.match(/Live location/g)).toHaveLength(1);
    expect(markup).not.toContain('class="placeholderText"');

    expect(visibleMessageText({ ...message, body: "Live location" })).toBeNull();
    expect(visibleMessageText({ ...message, body: "Live location", caption: "Meet at this pin" })).toBe("Meet at this pin");
    expect(visibleMessageText({ ...message, body: "Meet me here" })).toBe("Meet me here");
  });

  it("uses the Deleted chip as the only deletion-detail control", () => {
    const message = listMessage({
      body: null,
      messageType: "revoked",
      isDeleted: true,
      structuredSignals: {
        mentionCount: 0,
        location: null,
        vcards: [],
        deletion: { revokedAtMs: deletedAtMs },
        edit: null,
        mediaInterpretations: [],
        captureVersion: 1
      }
    });
    const markup = renderToStaticMarkup(createElement(MessageBubble, { message, isGroup: false, onOpenMedia: () => undefined }));
    expect(markup).toContain('class="deletedChip clickable"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("Deletion details");
  });

  it("keeps deleted media out of grouped grids so its state chip stays actionable", () => {
    const media = (id: number, isDeleted = false) => listMessage({
      id,
      sourceMessageId: `media-${id}`,
      body: null,
      hasMedia: true,
      messageType: "image",
      isDeleted,
      media: { availability: "stored", assetId: id, mimeType: "image/jpeg" } as MessageListItem["media"]
    });
    const entries = groupConsecutiveMedia([media(1), media(2), media(3, true), media(4), media(5), media(6), media(7)]);
    expect(entries.some((entry) => entry.kind === "grid")).toBe(true);
    expect(entries.some((entry) => entry.kind === "grid" && entry.messages.some((message) => message.isDeleted))).toBe(false);
    expect(entries.some((entry) => entry.kind === "single" && entry.message.id === 3)).toBe(true);
  });
});
