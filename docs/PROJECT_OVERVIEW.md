# Project Overview

Wapp Brain is a local-first WhatsApp archive and second-brain engine.

The project exists because the user wants a durable, queryable, private store of their WhatsApp messages. It starts with Android backup import, then grows into live updates and a private second-brain wiki layer.

## App Scope

The app can:
- Initialize a local SQLite archive.
- Import plaintext `msgstore.db` fixtures or already-decrypted databases.
- Decrypt/import `msgstore.db.crypt15` with user-supplied key material.
- Optionally use `wa.db` for contact names.
- Preserve normalized chats, contacts, participants, messages, message metadata, warnings, and import runs.
- Archive media locally (import backfill + live download, including view-once) and render it in the thread view.
- Browse chats and messages in a local web UI.
- Re-run imports without duplicating the same messages.

The app does not:
- Listen to live WhatsApp messages.
- Build embeddings, summaries, generated private wiki files, or second-brain answers.
- Use a cloud database by default.

## Product Principles

Privacy and correctness come first.

The app should be useful before it is ambitious. Each phase should make the archive more complete, more trustworthy, or easier to inspect without compromising local-first behavior.

## Intended Shape

1. Import from encrypted Android backups.
2. Local archive validation and browsing.
3. Live message ingestion through Baileys or a similar explicit client bridge.
4. Rich local search and retrieval.
5. Second-brain wiki generation and question answering with citations to exact source messages.
6. Optional remote sync/service backends only after explicit privacy review and user opt-in.
