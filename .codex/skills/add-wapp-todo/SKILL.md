---
name: add-wapp-todo
description: Add a new Wapp Brain idea, bug, investigation, or feature request to the repo-local behavior backlog under openspec/todos. Use when the user wants to capture a todo/backlog item for this project without immediately implementing it, especially when they mention a new idea, feature plan, bug observation, behavior expectation, or future OpenSpec change.
---

# Add Wapp Todo

## Workflow

1. Work from the repository root when possible.
2. Read `openspec/todos/README.md` and at least one existing todo that is similar to the request.
3. Create one Markdown file in `openspec/todos/` for each distinct backlog item.
4. Update the index table in `openspec/todos/README.md`.
5. Do not implement code unless the user explicitly asks for implementation too.

## Todo Format

Use behavior-first sections. Prefer this structure:

```markdown
# Title

## Type

Bug | Feature | Investigation | Bug / design follow-up

## Status

Idea | Needs reproduction | Needs investigation | Needs specification | Ready to propose

## User Observation

What the user saw, wants, or suspects.

## Expected Behavior

The durable product behavior that should hold even if code changes.

## Behavior Questions

- Open question about desired behavior.

## Privacy Notes

Any local-first or sensitive-data constraints.

## Acceptance Sketch

- **WHEN** ...
- **THEN** ...
```

Use `## User Goal` instead of `## User Observation` for pure feature ideas when that reads better.

## Writing Rules

- Keep the entry behavior-specific, not code-specific.
- Avoid implementation file names, functions, schema details, raw rows, or stack traces unless the user explicitly asks to preserve technical evidence.
- Never include real WhatsApp message bodies, keys, media, raw database dumps, private paths, or generated archive data.
- Preserve uncertainty. If the user says "maybe" or "my suspect is", write it as a theory or investigation question, not as fact.
- Keep acceptance sketches small and scenario-like, following the OpenSpec style already used in this repo.
- If several items are mixed together, split them into separate files unless they are clearly one product behavior.

## Naming

Use a short kebab-case filename based on the desired behavior, for example:

- `media-folder-import-reliability.md`
- `inbox-sorting-includes-system-updates.md`
- `mcp-chat-reader-server.md`

If the item is likely to become a formal OpenSpec change soon, choose a filename that can also work as a future change id.

## Final Response

Summarize the created or updated todo file links and mention that no implementation was done unless code was explicitly changed.
