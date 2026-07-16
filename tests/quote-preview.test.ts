import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageListItem, QuotedMessageSnapshotSummary } from "../src/shared/types";
import { quotePreviewModel, quotePreviewText } from "../src/client/quotePreview";
import { QuotedPreview } from "../src/client/thread";

function message(id: number, quotedSnapshot: QuotedMessageSnapshotSummary | null): MessageListItem {
  return {
    id,
    sourceMessageId: `reply-${id}`,
    senderDisplayName: "Riya",
    senderSourceJid: "15550000000@s.whatsapp.net",
    timestampMs: 1,
    sentAt: null,
    direction: "incoming",
    messageType: "text",
    interpretation: null,
    body: "reply",
    caption: null,
    mentions: [],
    hasMedia: false,
    mediaMimeType: null,
    mediaName: null,
    media: null,
    linkPreview: null,
    quotedSnapshot,
    isEdited: false,
    editRevisionCount: 0,
    isDeleted: false,
    isForwarded: false,
    isStarred: false
  };
}

const longText = "complete quote ".repeat(30);
const snapshot: QuotedMessageSnapshotSummary = {
  quotedSourceMessageId: "original-1",
  quotedSourceChatId: "chat@s.whatsapp.net",
  quotedSenderSourceJid: "15550000001@s.whatsapp.net",
  quotedSenderDisplayName: "Avery",
  quotedSenderNameIsPushName: false,
  quotedFromMe: false,
  timestampMs: null,
  messageType: "image",
  body: longText,
  caption: null,
  mediaMimeType: "image/jpeg",
  mediaName: null,
  location: null,
  vcard: null,
  mentionedJids: [],
  hasThumbnail: true,
  originalMessageId: 91
};

describe("quoted thread preview model", () => {
  it("gives backup and live snapshots the identical local presentation", () => {
    const backup = quotePreviewModel(message(41, snapshot));
    const live = quotePreviewModel(message(41, structuredClone(snapshot)));

    expect(backup).toEqual(live);
    expect(backup).toMatchObject({
      sender: "Avery",
      text: longText,
      isLong: true,
      thumbnailUrl: "/api/messages/41/quoted-thumbnail",
      jumpMessageId: 91
    });
  });

  it("keeps complete long text in the API model; expansion is display-only", () => {
    const preview = quotePreviewModel(message(42, snapshot))!;

    expect(preview.text).toBe(longText);
    expect(preview.text.length).toBeGreaterThan(180);
    expect(preview.isLong).toBe(true);
  });

  it("uses deterministic structured context and only exposes valid jump/thumbnail targets", () => {
    const structured = quotePreviewModel(
      message(43, {
        ...snapshot,
        body: null,
        caption: null,
        location: { name: "Cafe", address: null },
        hasThumbnail: false,
        originalMessageId: null
      })
    );

    expect(structured).toMatchObject({ text: "Cafe", thumbnailUrl: null, jumpMessageId: null });
    expect(quotePreviewText({ ...snapshot, body: null, caption: null, location: null, vcard: { name: "Casey" } })).toBe("Casey");
  });

  it("keeps pointer-only compatibility and honestly renders no preview for missing context", () => {
    const pointerOnly = quotePreviewModel(
      message(44, {
        ...snapshot,
        body: "bounded archived original",
        quotedSourceChatId: null,
        hasThumbnail: false,
        originalMessageId: 88
      })
    );

    expect(pointerOnly).toMatchObject({ text: "bounded archived original", jumpMessageId: 88, thumbnailUrl: null });
    expect(quotePreviewModel(message(45, null))).toBeNull();
  });

  it("makes only a jumpable preview an unobtrusive interactive target", () => {
    const jumpable = renderToStaticMarkup(
      createElement(QuotedPreview, { message: message(46, snapshot), onJumpToMessage: () => undefined })
    );
    const nonJumpable = renderToStaticMarkup(
      createElement(QuotedPreview, { message: message(47, { ...snapshot, originalMessageId: null }), onJumpToMessage: () => undefined })
    );

    expect(jumpable).toContain('class="quotedPreviewTarget"');
    expect(jumpable).toContain('aria-label="Jump to original message from Avery"');
    expect(jumpable).not.toContain(">Jump to original<");
    expect(nonJumpable).toContain('class="quotedPreviewStatic"');
    expect(nonJumpable).not.toContain("quotedPreviewTarget");
  });
});
