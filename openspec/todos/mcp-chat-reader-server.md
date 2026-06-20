# MCP Chat Reader Server

## Type

Feature

## Status

Idea

## User Goal

Provide a local MCP server that allows ChatGPT or another AI agent to read specific WhatsApp chats when the user instructs it to.

## Expected Behavior

The app should expose a local, permission-conscious interface for AI tools to retrieve selected WhatsApp chat context from the archive.

Access should be explicit and scoped. An AI agent should not gain broad archive access just because the MCP server exists. The user should be able to choose which chats, time windows, or searches are available for a given task.

Responses should preserve citation paths back to exact messages or archive records so generated answers can be checked against source material.

## Behavior Questions

- Should access be granted per chat, per search query, per time window, or per session?
- Should the server return raw messages, redacted snippets, summaries with citations, or all of those as separate tools?
- How should the user review what an AI agent requested and what was returned?
- Should the MCP server be disabled by default and started only from an explicit local control?

## Privacy Notes

This is privacy-sensitive. The MCP server should bind locally by default, avoid exposing the archive to the network, and make any remote-agent workflow an explicit opt-in.

The server should not upload data itself. If a connected AI client sends retrieved chat content to a hosted model, that must be a clear user decision outside the default local archive behavior.

## Acceptance Sketch

- **WHEN** the user enables MCP access for a specific chat scope
- **THEN** an AI agent can request only that permitted chat context.

- **WHEN** the agent receives messages or summaries
- **THEN** each answerable item includes citations back to exact archive messages.

- **WHEN** MCP access is disabled
- **THEN** no AI client can read WhatsApp archive content through the MCP interface.

