## Context

The client is a single `src/client/App.tsx` (~3,660 lines, ~70 `useState` hooks, plus a
second HTML entry `wa-contacts.html` → `waContacts/WaContactsPage.tsx`). One component owns
the chat list, thread view, global search, import wizard, Google Contacts, memory, and brain
panels — all as collapsible sidebar sections plus a message pane. Nothing is URL-addressable:
you cannot link to a chat, reload into the import wizard, or bookmark the brain panel.

What already exists that this change builds on:
- **Production reload-safety is already wired**: `src/server/server.ts` serves `dist/` static
  and has an SPA catch-all `app.get(/.*/, → dist/index.html)`. Any client route reloads cleanly
  in production today; the missing piece is a client router to interpret the path.
- **Dev reload-safety**: Vite's dev server serves `index.html` for unmatched non-file routes
  (default SPA behavior). The current multi-entry build (`index.html` + `wa-contacts.html`) is
  the only wrinkle; folding the wa.db viewer into an SPA route removes the second entry.
- **Server-side meaning is settled**: every surface consumes the same DTOs (`src/shared/types.ts`)
  via `src/client/api.ts`. No server change is needed or wanted — the SSE contract
  (`/api/archive/events`) and all `/api/*` endpoints stay exactly as they are.
- **Cross-cutting live state** already lives in App: an `EventSource` subscription to
  `archive-updated`, status polling (`/api/status`), brain overview/run polling, live-progress
  polling, and search index/reindex polling. These must become shared, not per-page.

Five upcoming roadmap changes each add a substantial surface (People management #6, eval grading
#7, brain query panel #12, grants UI #13, backfill dashboard #14). This change lands the route
architecture **before** them so they are born as pages, not extracted from a monolith later.
Constraint from the roadmap: **behavior-faithful, not pixel-faithful** — no behavioral changes in
this pass; the same actions must still work, just relocated to owning pages.

## Goals / Non-Goals

**Goals:**
- A client-side router (`react-router-dom` v7) with one URL per surface, lazy route-level code
  splitting, reload-safety, and working browser back/forward.
- `App.tsx` reduced to a composition shell (providers + router mount); the visual shell (topbar,
  nav, toast host, onboarding banner, per-route error boundary, `<Outlet/>`) in `shell/`.
- Cross-cutting state (SSE subscription, archive/live/brain status, toasts) lifted into shared
  contexts/hooks; page-local state (thread scroll, wizard form fields, filters) stays in pages.
- Existing surfaces moved to page components under `src/client/pages/`, API calls colocated,
  behavior preserved.
- Deep links: a search hit opens `/chats/:id?at=<messageId>` centered on the hit; a mid-import
  reload returns to the wizard's live progress; the brain "run due" indicator navigates to `/brain`.
- The wa.db contacts viewer folds from its own HTML entry into the `/contacts` route (second Vite
  entry removed).
- A **standing rule** recorded in the spec: new UI is new routes/pages (or sections of an owning
  page), never additions to a shared mega-component.

**Non-Goals:**
- No server changes (routes, DTOs, SSE contract all unchanged).
- No visual redesign; pixel-faithful is explicitly not required.
- No new surfaces — `/people`, `/brain/query`, `/brain/eval`, and grants under `/settings` are
  **reserved** (documented, not built) for their owning changes.
- No new client test framework (jsdom/RTL). Route/deep-link logic is validated by extracting pure,
  Node-testable helpers plus a manual checkpoint list; existing `vitest run` stays green.

## Decisions

### D1 — Router: `react-router-dom` v7, `BrowserRouter` + `<Routes>`, `React.lazy` per page
`react-router-dom@7` is React-19 compatible and is the standard the proposal names. Use
`<BrowserRouter>` wrapping a `<Routes>` tree, with each page as `React.lazy(() => import(...))`
inside a `<Suspense>` fallback — this gives route-level code splitting (one chunk per page) with
minimal ceremony. A shell layout route renders the chrome + `<Outlet/>`; pages are its children.
- *Alternative — `createBrowserRouter` data router*: more powerful (loaders/actions) but its data
  APIs would pull data-fetching out of pages we are deliberately keeping page-local this pass;
  more surface area for a refactor whose point is structure, not data-loading. Rejected for now;
  the `<Routes>` tree can migrate to a data router later without touching pages.
- *Alternative — hand-rolled `history` + context router*: avoids a dependency but re-implements
  params, nested routes, code-splitting, and back/forward that react-router gives for free. The
  proposal explicitly sanctions react-router. Rejected.

### D2 — Route map (information architecture)
The proposal's starting list is adopted with the cross-cutting panels resolved to owning pages.
Primary nav: **Chats · Search · Brain · Contacts · Import · Settings**.

| Route | Page | Absorbs (from today) |
|---|---|---|
| `/` | redirect → `/chats` | — |
| `/chats` | ChatsPage (list pane) | chat list + filters (`browse-worthy-chat-list`) |
| `/chats/:id` | ChatsPage (list + thread) `?at=<messageId>` | thread view (`whatsapp-style-thread-view`), anchor deep link |
| `/search` | SearchPage | global search box + filters + results; hits → `/chats/:id?at=` |
| `/brain` | BrainPage | BrainPanel (provider+runs+coverage+owner+reset) **and** MemoryPanel |
| `/contacts` | ContactsPage | GoogleContactsPanel + wa.db viewer (folded from `wa-contacts.html`) |
| `/import` (+ `/import/key`, `/import/mode`, `/import/run`) | ImportPage | ImportWizard steps as sub-routes |
| `/settings` | SettingsPage | StatusPanel (counts/init-db/cleanup) + LivePanel (link/pause/resume/unlink/gaps/media-retry) + theme |
| reserved | — | `/people`, `/brain/query`, `/brain/eval`, grants under `/settings` |

Rationale for placing the un-routed panels:
- **Onboarding → shell banner** (not a route): it is first-run north-star guidance
  (Backup → Archive → Live Sync) that is inherently cross-cutting and status-driven. It renders in
  the shell when setup is incomplete and hides when complete; its CTAs navigate (`Import` → `/import`)
  or open the pairing modal.
- **Live (WhatsApp maintainer) → `/settings`**: session/connection *management* is settings-shaped;
  the *status* (connected/dot + gap count) surfaces as a shell nav indicator so it stays glanceable.
  The onboarding banner's "Link WhatsApp" still opens pairing in one click.
- **Brain provider config stays on `/brain`** (not split to `/settings`): the current BrainPanel
  couples provider probe/enable/model-select with runs; keeping it whole is the behavior-faithful
  choice. `/settings`'s "provider/model config" scope is honored by hosting the *memory* provider
  toggle context and leaving room for the reserved grants section. Documented so a reviewer sees the
  deliberate deviation from a naive reading.
- **Memory → section of `/brain`**: memory is a second-brain sibling and is slated for teardown at
  change #15; giving it a section on `/brain` keeps it reachable and reload-safe without minting a
  route that will be deleted.

### D3 — Shared state: two contexts, page-local everything else
- **`StatusProvider` / `useStatus()`** owns the singleton `EventSource('/api/archive/events')`,
  status polling (`refreshStatus`), `liveGaps`, `brainOverview`, `brainRun` (+ its running poll),
  `liveProgress` (+ its poll), and `searchIndex`/`reindexProgress` (+ its poll). It exposes read
  values, imperative refreshers, and **`useArchiveEvents(cb)`** — a subscribe hook so a page (Chats)
  can react to `archive-updated` (refresh its list / follow the selected thread) without the provider
  knowing about page state. One SSE connection for the whole app; the provider throttles global
  refresh (1s) exactly as App does today.
- **`ToastProvider` / `useToast()`** owns `notice`/`error` and `setNotice`/`setError`; the shell
  renders the single toast host. Any page or the status provider pushes toasts. Failures stay
  visible app-wide (e.g. a failed search-index build raises the error toast regardless of route),
  matching current behavior.
- **Page-local** (lives in the page component, not shared): thread messages + scroll refs +
  jump/anchor context, chat-list pagination, search filters, wizard form fields, memory query.

### D4 — Thread deep links and the anchor window
`/chats/:id` reads `id` from params and `at` from `useSearchParams()`. On mount / param change:
no `at` → load newest page and scroll to bottom (today's default); `at=<messageId>` → load the
context window (`getMessageContext`) centered on the anchor and scroll it into view. A search hit
navigates to `/chats/:id?at=<messageId>` instead of the current in-component `openSearchHit` panel
switch. Exiting the jump window (`Latest messages`) navigates to `/chats/:id` (drops `?at`). The
anchor/scroll/`isNearBottom` SSE-follow logic moves verbatim into the ThreadView — behavior-faithful.
A pure helper `buildChatDeepLink(chatId, anchorId?)` / `parseAnchorParam(searchParams)` is extracted
to `lib/deepLinks.ts` and unit-tested under `tests/` (Node-only, no DOM).

### D5 — Import wizard as reload-safe sub-routes
Steps become URL sub-routes: `/import` (folder) → `/import/key` → `/import/mode` → `/import/run`.
The reload-safety that *matters* — an in-progress import — is fully honored: `/import/run` reattaches
the active server job via `getCurrentImportJob()` and renders live progress, because the job is
server-owned. Pre-start form fields (backup path, key, mode) are transient by nature and reset on
reload; to keep the flow coherent, `/import/key` and `/import/mode` **redirect to `/import`** when
their prerequisite state is absent, and `/import` **redirects to `/import/run`** when a job is
already active. This delivers "mid-import reload returns to the wizard's live progress" without
fabricating persistence for un-submitted inputs. The pairing modal and media lightbox remain
modals (overlays, not surfaces) rendered by their owning pages/shell.

### D6 — Fold the wa.db viewer into the SPA; drop the second Vite entry
`waContacts/WaContactsPage.tsx` becomes `pages/contacts/WaContactsView.tsx` (its own topbar/shell
removed — the app shell provides that) and renders as a section of `/contacts`. `wa-contacts.html`,
`waContacts/main.tsx`, and the `waContacts` input in `vite.config.ts` `rollupOptions.input` are
removed; the old `href="/wa-contacts.html"` link becomes a nav/route link to `/contacts`. The pure,
already-tested `filterContacts.ts` **stays at its current path** so `tests/waContacts*.test.ts`
imports are untouched (correctness over tidiness); the page imports it from there.

### D7 — File structure
```
src/client/
  main.tsx                 mounts <App/>
  App.tsx                  shell: <ToastProvider><StatusProvider><BrowserRouter><AppRoutes/>>  (reduced to shell)
  routes.tsx               <Routes> tree with React.lazy pages + <Suspense>
  shell/  AppShell.tsx (topbar+nav+toast host+onboarding banner+<Outlet/>), NavRail.tsx,
          OnboardingBanner.tsx, RouteErrorBoundary.tsx, ToastHost.tsx
  state/  StatusContext.tsx, ToastContext.tsx
  pages/  chats/ (ChatsPage, ChatList, ThreadView, MessageBubble+media bubbles, EditHistoryModal,
                  MediaLightbox, messageRender.tsx)
          search/ (SearchPage, GlobalSearchResults)
          import/ (ImportPage + step components, PairingModal)
          contacts/ (ContactsPage, GoogleContactsPanel, WaContactsView)
          brain/ (BrainPage, BrainPanel, MemoryPanel)
          settings/ (SettingsPage, StatusPanel, LivePanel)
  lib/    format.ts (date/time/bytes/duration), deepLinks.ts (unit-tested)
  api.ts                   unchanged this pass (per-domain split deferred)
  waContacts/filterContacts.ts   unchanged (kept for stable test imports)
```

## Risks / Trade-offs

- **Large mechanical move risks behavioral regressions** (scroll anchoring, SSE-follow, wizard job
  reattach, memory citation resolution). → Move logic verbatim (same handlers, same effects) rather
  than rewriting; keep a per-surface manual checkpoint in `tasks.md`; build + `vitest run` gate every
  step; drive the real archive in a browser at the end.
- **One shared `EventSource` must serve both global refresh and page reactions.** → `useArchiveEvents`
  subscription registry decouples them; the provider owns the connection lifecycle (open once, close
  on unmount), pages register/unregister listeners. Avoids N connections or a page-owned SSE that dies
  on navigation.
- **New dependency (`react-router-dom`) + lockfile change.** → Sanctioned by the proposal; single
  well-maintained dep; added on this branch only. `npm run build` (tsc + vite) proves it resolves.
- **Route-level `React.lazy` + `Suspense` can flash on navigation.** → Lightweight route fallback
  (spinner consistent with existing `Loader2` usage); pages are small, chunks load fast on loopback.
- **IA judgment calls (Live→Settings, Memory→Brain, provider stays on Brain) are made without the
  interactive review the proposal envisioned.** → Each deviation is documented above with rationale;
  none change behavior, and re-homing a section later is cheap once everything is already a page.
- **Import pre-start fields reset on reload** (not truly reload-safe for un-submitted steps). →
  Accepted and documented: only an *in-progress* import is meant to be reload-safe; step guards keep
  the flow coherent rather than persisting transient form state.

## Migration Plan

Incremental, each step building green (`npm run build` + `npm test`):
1. Add `react-router-dom`; introduce `ToastProvider` + `StatusProvider`, port the SSE/polling
   effects into `StatusContext` behind `useStatus()`/`useArchiveEvents()`.
2. Stand up the shell (`AppShell` + `NavRail` + `ToastHost` + `OnboardingBanner` +
   `RouteErrorBoundary`) and the `<Routes>` tree with placeholder pages behind the layout route.
3. Move surfaces page-by-page (Chats+Thread, Search, Contacts+wa.db, Brain+Memory, Settings,
   Import sub-routes), deleting the equivalent App code as each lands. Wire deep links (search hit →
   route, onboarding/brain indicator → route).
4. Remove the second Vite entry (`wa-contacts.html`) and reduce `App.tsx` to the shell.
5. Verify: build, tests, and a manual smoke on the real archive (each surface at its URL, reload-safe,
   search deep link navigates, mid-import reload lands on live progress, back/forward intact).

**Rollback**: pure client refactor on an isolated branch; revert the branch. No data, schema, or
server-contract changes exist to unwind.

## Open Questions

- Should Live sync get its own top-level `/settings/live` sub-route rather than a section of
  `/settings`? Deferred: a section is sufficient now and cheap to promote when `historical-backfill`'s
  dashboard arrives.
- Does the brain provider/model config eventually move to `/settings` alongside the reserved grants
  UI (change #13)? Left on `/brain` this pass for behavior-fidelity; #13 can relocate it deliberately.
