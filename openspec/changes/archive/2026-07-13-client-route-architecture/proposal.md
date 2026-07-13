# Client Route Architecture

> Proposal-level seed (2026-07-11). Expand with `/opsx:propose` when scheduled. See `openspec/changes/ROADMAP.md` for ordering and dependencies. **Recommended model: Opus.**

## Why

The client is one 3,629-line `App.tsx` with ~70 state hooks and no router: chats, thread view, global search, the import wizard, Google contacts, the wa.db viewer, and the Brain panel all share a single page and a single component's state. Nothing is URL-addressable — you cannot link to a chat, reload into the import wizard, or bookmark the Brain panel. Five upcoming changes each add a substantial new surface (People management, eval grading, the brain query panel, grants list, backfill dashboard); piling them into the same component makes every future UI change slower and riskier. This change breaks the client into route-based pages **before** those surfaces land, so they are born as pages instead of being extracted later.

## What Changes

- **Route map exploration first**: the design phase deliverable is a reviewed information architecture — which surfaces are pages, which are panels within pages, what the nav looks like — before any code moves. Starting point to be challenged in design: `/chats`, `/chats/:id` (+ `?at=<message>` for search deep links), `/search`, `/import` (wizard steps as sub-routes so reload lands back in the flow), `/contacts` (Google sync + wa.db viewer), `/brain` (status/runs/coverage), `/settings` (provider/model config); reserved for later changes: `/people`, `/brain/query`, `/brain/eval`, grants under `/settings`.
- **Router adoption**: client-side router (e.g. react-router) with lazy route-level code splitting; every surface deep-linkable and reload-safe; browser back/forward work.
- **App shell**: shared layout (nav, connection/status indicators, toast host, error boundary per route) with cross-cutting state — SSE subscription, archive status, brain status — in shared contexts/hooks; page-local state lives in page components.
- **Decomposition**: `App.tsx` reduces to shell + routes; existing surfaces move to page components under `src/client/pages/` with their API calls colocated; no behavioral changes in this pass (pixel-faithful is not required, behavior-faithful is).
- **Deep-link integration**: search results, toasts, and the brain "run due" alert navigate via routes (e.g. a search hit opens `/chats/:id?at=<key>`), replacing in-component panel switching; SSE-driven refreshes keep working per page.
- **Standing rule for future changes**: new UI features are new routes/pages (or sections of an owning page), never additions to a shared mega-component — recorded so `people-management-ui`, `brain-retrieval-pipeline`, `mcp-agent-surface`, and `historical-backfill` build on clean ground.
- **Checkpoint**: every existing surface reachable at its own URL and reload-safe; a search deep link opens the thread centered on the hit via the route; mid-import reload returns to the wizard's live progress; `App.tsx` is a shell; full test suite and manual smoke on the real archive pass.

## Capabilities

### New Capabilities

- `client-navigation`: route-addressable surfaces — URL per surface, deep-linkability, reload-safety, back/forward integrity, shell/page state separation, and the pages-not-panels rule for future UI.

### Modified Capabilities

- `whatsapp-style-thread-view`: thread view becomes `/chats/:id` with anchor-message deep links as URLs (previously in-component navigation).
- `premium-onboarding-workflow`: import wizard becomes route-based with reload-safe steps.
- `browse-worthy-chat-list`: chat list becomes the `/chats` page; selection is a route change.

## Impact

- **Code**: `src/client/` restructure — `pages/`, `shell/`, shared hooks/contexts; router dependency added; `main.tsx` mounts the router; `api.ts` optionally split per page domain.
- **No server changes**: routes consume the same DTOs (server-side meaning principle unchanged); SSE contract untouched.
- **Tests**: client build + existing API tests unaffected; add route smoke checks if a client test harness exists, else manual checkpoint list in tasks.
- **Depends on**: nothing (pure client refactor, parallel to all server-side work). **Must land before** `people-management-ui` and the UI halves of `brain-retrieval-pipeline`; strongly recommended before `brain-eval-harness`'s grading strip, `mcp-agent-surface`'s grants UI, and `historical-backfill`'s dashboard.
