# Live WhatsApp Maintainer

The live maintainer is an optional local engine for keeping a backup-imported archive current after the initial dump.

## Client Choice

The first client is Baileys because it talks to WhatsApp Web through code and WebSockets. Browser automation clients such as `whatsapp-web.js` and `open-wa` are intentionally out of scope for this feature.

## How Sync Works

The maintainer ingests:
- real-time message events
- offline append events after reconnect
- history sync chunks
- bounded targeted history requests when supported

Every chat gets its own checkpoint. A quiet chat with a deeper suspected gap can be recovered independently from active chats that are already current.

## Baseline Required

Live sync requires an existing imported backup baseline. Pairing and live start commands refuse to run when:
- no archive import exists
- the archive contains no messages
- the latest archived message is older than the configured recovery window

This is intentional. Live updates are a maintainer for a known archive, not a reliable substitute for the initial backup import. If the latest archived data is too old, import a fresher backup first so the live maintainer only has to recover a bounded, WhatsApp-Web-reliable gap.

The UI follows the same rule:
- no baseline shows `Import backup`
- ready but unlinked shows `Link WhatsApp`
- active sync shows `Pause sync`
- paused sync shows `Resume sync` and `Unlink device`
- disconnected sessions show reconnect/unlink actions
- uncertain gaps show review/retry guidance

`Pause sync` stops the local maintainer while keeping linked-device credentials. `Unlink device` removes local live credentials and requires pairing again.

## Read-Only Guardrails

WhatsApp linked devices do not expose a true read-only permission scope. Wapp Brain enforces app-level read-only behavior by:
- exposing only receive/history methods through its live adapter
- setting `markOnlineOnConnect: false`
- never calling `readMessages`, send, edit, delete, reaction, presence, chat-modify, group-modify, or profile-update APIs
- replacing known write-capable Baileys socket methods with throwing guards during live maintainer runs

The maintainer writes only to the local archive and local live state.

## Local Spike Result

The first linked-device proof run on June 14, 2026 completed successfully:
- Baileys connected as a linked device.
- `messages.upsert` was observed.
- `messaging-history.set` was not observed during the short proof window.
- On-demand history support remains probed as `null` until a longer anchored recovery run is performed.

Given that result, initial backfill defaults remain conservative: one chat at a time, 2,000 messages or 14 days per chat, 3 seconds between attempts, and 5 retries before marking uncertainty.

## Recovery Limits

Default recovery limits:
- 2,000 backfill messages per chat
- 14 days per chat
- 1 concurrent chat backfill
- 3 seconds between backfill attempts
- 5 retries per gap

When a gap cannot be proven closed inside those limits, the chat is marked `uncertain` or `needs_user_action`. That is deliberate: the archive should not claim completeness when WhatsApp Web did not provide enough evidence.

## Commands

```powershell
npm run live:proof -- --phone <countrycode-number>
npm run live:start -- --phone <countrycode-number>
npm run live:status
npm run live:gaps
tsx src/server/cli.ts live-retry-gap --id <gap-id>
tsx src/server/cli.ts live-unlink
```

`live-proof` writes a local spike result under `.wapp-brain/live/baileys-spike.json`.

The app UI can also start the read-only live pairing flow after baseline readiness. QR and pairing-code status are served from the local app server and update without refreshing the page.

## Privacy

Live auth state is stored under `.wapp-brain/live`. Do not commit it, upload it, paste pairing codes into logs, or share generated debug files without reviewing them as sensitive WhatsApp account data.
