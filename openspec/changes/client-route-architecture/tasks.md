# Tasks — client-route-architecture

Each numbered group leaves the tree building green (`npm run build`) and `npm test` passing.
Surfaces move one at a time; App code is deleted as each surface lands elsewhere.

## 1. Dependency and shared foundation

- [x] 1.1 Add `react-router-dom` (v7) to `package.json` dependencies (`npm install react-router-dom`); confirm it resolves and `npm run build` still passes
- [x] 1.2 Extract the App.tsx component region verbatim into two cohesive modules at `src/client/` root (paths unchanged): `thread.tsx` (message/media rendering toolkit + the pure `formatDate`/`formatTime`/`formatBytes`/`msToIso`/`chatDisplayLabel`/thread-grouping helpers, exported) and `panels.tsx` (status/live/brain/memory/onboarding/search panels + import wizard, exported). Formatters stay co-located in `thread.tsx` rather than a separate `lib/format.ts` — a deliberate simplification since the verbatim slice keeps them adjacent to their users
- [x] 1.3 Create `src/client/lib/deepLinks.ts` with pure helpers `buildChatDeepLink(chatId, anchorId?)` → `/chats/:id[?at=]` and `parseAnchorParam(searchParams)` → `number | null`
- [x] 1.4 Add `tests/client-deep-links.test.ts` covering build/parse round-trips and the no-anchor and invalid-anchor cases; `npm test` green
- [x] 1.5 Create `src/client/state/ToastContext.tsx` — `ToastProvider` + `useToast()` exposing `notice`, `error`, `setNotice`, `setError`, `clear`
- [x] 1.6 Create `src/client/state/StatusContext.tsx` — `StatusProvider` + `useStatus()`. Ported from `App.tsx`, unchanged in behavior: `status`/`refreshStatus`, `statusError`, `liveGaps`, `brainOverview`, `brainRun` (+ running poll + completion toasts), `liveProgress` (+ poll), `searchIndex`/`reindexProgress` (+ reindex poll + failed-build error toast). Owns the single `EventSource('/api/archive/events')` and exposes `useArchiveEvents(cb)` for pages to subscribe to `archive-updated`. Keeps the 1s refresh throttle
- [x] 1.7 Confirm `StatusProvider` opens exactly one SSE connection (mount-only effect, `events.close()` on unmount); brain/live/reindex polls start/stop on the same conditions as the monolith

## 2. App shell and route skeleton

- [x] 2.1 Create `src/client/shell/RouteErrorBoundary.tsx` — a per-route error boundary (readable message + console log + reload), reset by keying on the route path in `AppShell`
- [x] 2.2 Create `src/client/shell/ToastHost.tsx` rendering the single `notice`/`error` toast line from `useToast()` plus the reindex-in-progress toast from `useStatus()`; positioned as a fixed overlay so a toast never shifts page layout
- [x] 2.3 Create `src/client/shell/OnboardingBanner.tsx` from `OnboardingPanel`; its CTAs navigate (`Import` → `/import`, `Review gaps` → `/settings`) or open pairing (`openLink`/`openResume`); hidden unless a setup action remains
- [x] 2.4 Create `src/client/shell/NavRail.tsx` — nav links (Chats, Search, Brain, Contacts, Import, Settings) with active state, a live-connection dot, and a brain "run due" badge that links to `/brain`
- [x] 2.5 Create `src/client/shell/AppShell.tsx` — topbar (brand, local badge, refresh, theme) + `NavRail` + `OnboardingBanner` + `ToastHost` + `PairingModal` + `RouteErrorBoundary`/`Suspense` wrapping `<Outlet/>`; also handles the Google OAuth `?googleContacts=` landing (toast + route to `/contacts`, no server change)
- [x] 2.6 Create `src/client/routes.tsx` — `<Routes>` with the `AppShell` layout route and `React.lazy` page children (Suspense fallback lives in the shell); `/` → `/chats`; a catch-all not-found route with a link to `/chats`
- [x] 2.7 Reduce `src/client/App.tsx` to the shell composition: `<ToastProvider><StatusProvider><BrowserRouter><AppRoutes/></BrowserRouter></StatusProvider></ToastProvider>`; `main.tsx` still mounts `<App/>` inside the top-level `AppErrorBoundary`
- [x] 2.8 (Not needed as a separate step) — pages were built and wired directly; each `npm run build` stayed green through the migration

## 3. Chats and thread surface (`/chats`, `/chats/:id`)

- [x] 3.1 Thread-rendering helpers (`renderMentions`/`renderInline`/`renderInlineText`/`renderRichText`, `groupMessagesByDay`, `sortMessagesChronologically`, `groupConsecutiveMedia`, `isGridMedia`, `sameGridRun`, `isSystemEvent`, `messagePlaceholder`, `humanizeMessageType`, `isNearBottom`, date/byte formatters) live in the verbatim-sliced `src/client/thread.tsx` and are exported to the pages
- [x] 3.2 Media components (`MessageBubble`, `MediaGridBubble`, `MessageMediaView`, `AudioBubble`, `VideoBubble`, `LinkPreviewCard`, `MediaLightbox`, `EditHistoryModal`, `useInlinePlayer` + constants) live verbatim in `src/client/thread.tsx`, exported for the chats page
- [x] 3.3 Create `src/client/pages/chats/ChatList.tsx` — filters + list + load-more + skeletons; a chat click navigates via `buildChatDeepLink(chat.id)`; the selected id comes from the `:id` route param
- [x] 3.4 Create `src/client/pages/chats/ThreadView.tsx` — newest window, older-scroll auto-load, jump/anchor window, `messageQuery`, SSE-follow via `useArchiveEvents` + `isNearBottom`, lightbox; reads `:id` and `?at` (`parseAnchorParam`), loads the centered window for an anchor, and "Latest messages" navigates to `/chats/:id`
- [x] 3.5 Create `src/client/pages/chats/ChatsPage.tsx` composing `ChatList` + `ThreadView` (two-pane), owning list state, deriving the open chat (loaded list → router state → cold stub), empty-thread state when no `:id`
- [x] 3.6 Old chat/thread/media code removed from `App.tsx`; `/chats` and `/chats/:id` routes wired; build + tests green

## 4. Search surface (`/search`)

- [x] 4.1 Create `src/client/pages/search/SearchPage.tsx` — search box, `GlobalSearchResults` (from `panels.tsx`), filters, debounced `searchArchive`, reindex CTA; index/reindex state from `useStatus`
- [x] 4.2 A result opens via `navigate(buildChatDeepLink(chatId, messageId), { state: { chat } })` → `/chats/:id?at=<messageId>`, seeding the header and centering the thread on the hit
- [x] 4.3 `renderSearchSnippet` lives with `GlobalSearchResults` in `panels.tsx`; `/search` route wired; build green

## 5. Contacts surface (`/contacts`) and single-entry SPA

- [x] 5.1 `GoogleContactsPanel` lives in `panels.tsx` (verbatim), driven from `ContactsPage` via `useStatus`/`useToast`
- [x] 5.2 Create `src/client/pages/contacts/WaContactsView.tsx` from the standalone page with its topbar/shell removed; still imports the pure `filterContacts` from `src/client/waContacts/filterContacts.ts` so `tests/waContacts*.test.ts` are untouched
- [x] 5.3 Create `src/client/pages/contacts/ContactsPage.tsx` composing the Google panel + wa.db viewer; `/contacts` route wired
- [x] 5.4 Second Vite entry removed: deleted `wa-contacts.html`, `src/client/waContacts/main.tsx`, `waContacts/WaContactsPage.tsx`; `vite.config.ts` back to single-entry; the old `/wa-contacts.html` link is now the `/contacts` nav link
- [x] 5.5 Build green (single-entry SPA); tests green (contacts filter tests pass)

## 6. Brain surface (`/brain`)

- [x] 6.1 `BrainPanel` lives verbatim in `panels.tsx`; `BrainPage` provides provider/run/owner/reset handlers via `useStatus`/`useToast`
- [x] 6.2 `MemoryPanel` lives verbatim in `panels.tsx`; `BrainPage` provides memory run/preview/query/citation/provider handlers
- [x] 6.3 Create `src/client/pages/brain/BrainPage.tsx` composing both; `/brain` route wired; build green

## 7. Settings surface (`/settings`)

- [x] 7.1 `StatusPanel` lives verbatim in `panels.tsx`; `SettingsPage` provides init-db/cleanup handlers
- [x] 7.2 `LivePanel` lives verbatim in `panels.tsx`; `SettingsPage` provides pause/unlink/gap-retry/media-retry handlers; link/resume + the pairing modal + its poll are owned by `StatusContext` and rendered from the shell
- [x] 7.3 Create `src/client/pages/settings/SettingsPage.tsx` composing Archive + Live sections; `/settings` route wired; build green

## 8. Import surface with sub-routes (`/import`, `/import/key`, `/import/mode`, `/import/run`)

- [x] 8.1 Create `src/client/pages/import/ImportPage.tsx` — maps the URL segment to the wizard step and drives the wizard; the wizard keeps its own transient form state (page-local within the wizard)
- [x] 8.2 (As built) — rather than fracturing the wizard, `ImportWizard` (in `panels.tsx`) gained optional controlled `step`/`onStepChange` props so the URL drives its step while its step JSX stays verbatim
- [x] 8.3 `ImportPage` reattaches the active job via `getCurrentImportJob()` on mount → `/import/run`; the wizard renders `ImportProgress`; completion refreshes status via `useStatus` (chat list refreshes via SSE)
- [x] 8.4 Step guards: `/import` redirects to `/import/run` when a job is active; `/import/key` and `/import/mode` redirect to `/import` when their prerequisite is absent and no job is active (guard lives in the wizard, where the state is)
- [x] 8.5 All wizard entry points navigate to `/import` (onboarding banner, settings live panel); `/import*` routes wired; wizard code removed from `App.tsx`; build green

## 9. Reduce App.tsx to a shell and remove dead code

- [x] 9.1 `App.tsx` is the provider + router composition only (18 lines; no surface JSX, no page state, no handlers)
- [x] 9.2 No dead `App`-local state remains; `api.ts` unchanged (all functions still consumed by pages/contexts)
- [x] 9.3 `npm run build` (tsc + vite) green; `npm test` green (217 tests, incl. 6 new deep-link tests)

## 10. Checkpoint verification

- [x] 10.1 Built the client and ran the server on `APP_PORT=3601` against a copied archive snapshot in this worktree's own `.wapp-brain/` (never 3600, never the live DB); loaded the app in a browser (snapshot deleted after)
- [x] 10.2 Every surface reachable at its own URL and reload-safe: deep routes return the SPA (200) and render; required fixing the Express SPA fallback to use `res.sendFile("index.html", { root })` (see note below)
- [x] 10.3 A search hit navigated to `/chats/99?at=297948` and opened the thread centered on the hit ("window around the selected search result"); a cold reload of that URL reproduced the centered window with the anchor message in the DOM
- [x] 10.4 Browser back/forward move between surfaces (verified /settings ⇄ /contacts); import sub-route guard verified (cold `/import/mode` → `/import`); mid-import reattach is the same `getCurrentImportJob()` mechanism the monolith used (verified by mechanism — no live import available to start)
- [x] 10.5 Async ops show progress (reindex/brain-run toasts, wizard progress) and failures surface as toasts + console; no console errors across the session; `App.tsx` is a shell; full `npm test` green

## Note: one server-side fix (outside the "no server changes" expectation)

The proposal expected no server changes. Verification surfaced that the pre-existing SPA history
fallback (`app.get(/.*/, → res.sendFile(absolutePath))`) 404s under Express 5 when the checkout
path contains a dot-segment (this worktree lives under `.claude/worktrees/…`), because `send`
defaults to `dotfiles: "ignore"` and checks the whole absolute path. It happens to work in the
main repo (no dot-segment in the path), but the reload-safety checkpoint must hold universally.
Fixed with the best-practice form `res.sendFile("index.html", { root: distDir })` (one line in
`src/server/server.ts`) — no DTO, route, or SSE-contract change.
