# Agent Instructions

Read `AGENT.md` first. It is the canonical future-agent guide for this repo.

This file remains because Codex-style tooling automatically discovers `AGENTS.md`.

## Short Version

Wapp Store is a local-first WhatsApp message store. It imports user-supplied Android backup data into a local SQLite archive, provides a local UI for browsing chats/messages, and is intended to grow into live ingestion plus a second-brain layer with cited answers.

## Hard Rules

- Keep WhatsApp data local by default.
- Do not upload chats, contacts, metadata, media, decrypted databases, keys, or logs.
- Do not bypass protections or recover data without user-supplied files and keys.
- Do not log keys, message bodies, decrypted DB contents, or raw row dumps by default.
- Never commit real WhatsApp files, keys, media, generated archives, `.env`, or `.wapp-store/`.

## Current Docs

- `docs/README.md` - wiki index
- `docs/PROJECT_OVERVIEW.md` - product overview
- `docs/ARCHITECTURE.md` - app/data flow
- `docs/IMPORTING_AND_DATA_MODEL.md` - importer behavior
- `docs/SECURITY_AND_PRIVACY.md` - privacy guardrails
- `docs/ROADMAP.md` - future live store and second brain
- `docs/TESTING.md` - verification
- `docs/LIMITATIONS.md` - known edges
