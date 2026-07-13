# Tasks — client-route-architecture

Each numbered group leaves the tree building green (`npm run build`) and `npm test` passing.
Surfaces move one at a time; App code is deleted as each surface lands elsewhere.

## 1. Dependency and shared foundation

- [ ] 1.1 Add `react-router-dom` (v7) to `package.json` dependencies (`npm install react-router-dom`); confirm it resolves and `npm run build` still passes
- [ ] 1.2 Create `src/client/lib/format.ts` and move the pure formatters out of `App.tsx` (`formatDate`, `formatTime`, `formatDateTime`, `formatBytes`, `formatDuration`, `msToIso`, `progressPercent`, `hasArchiveData`, `chatDisplayLabel`, `escapeRegExp`); re-export nothing else changes behavior
- [ ] 1.3 Create `src/client/lib/deepLinks.ts` with pure helpers `buildChatDeepLink(chatId, anchorId?)` → `/chats/:id[?at=]` and `parseAnchorParam(searchParams)` → `number | null`
- [ ] 1.4 Add `tests/client-deep-links.test.ts` covering build/parse round-trips and the no-anchor and invalid-anchor cases; `npm test` green
- [ ] 1.5 Create `src/client/state/ToastContext.tsx` — `ToastProvider` + `useToast()` exposing `notice`, `error`, `setNotice`, `setError`, `clear`
- [ ] 1.6 Create `src/client/state/StatusContext.tsx` — `StatusProvider` + `useStatus()`. Move from `App.tsx`, unchanged in behavior: `status`/`refreshStatus`, `statusError`, `liveGaps`, `brainOverview`, `brainRun` (+ running poll), `liveProgress` (+ poll), `searchIndex`/`reindexProgress` (+ reindex poll + failed-build error toast). Own the single `EventSource('/api/archive/events')` and expose `useArchiveEvents(cb)` for pages to subscribe to `archive-updated`. Keep the 1s refresh throttle
- [ ] 1.7 Confirm `StatusProvider` opens exactly one SSE connection and closes it on unmount; brain/live/reindex polls start/stop on the same conditions as today

## 2. App shell and route skeleton

- [ ] 2.1 Create `src/client/shell/RouteErrorBoundary.tsx` — a per-route error boundary (reuse the existing `AppErrorBoundary` pattern: readable message + console log + reload)
- [ ] 2.2 Create `src/client/shell/ToastHost.tsx` rendering the single `notice`/`error` toast line from `useToast()` plus the reindex-in-progress toast from `useStatus()`
- [ ] 2.3 Create `src/client/shell/OnboardingBanner.tsx` from `OnboardingPanel`; its CTAs navigate (`Import` → `/import`) or open pairing; hidden when setup is complete
- [ ] 2.4 Create `src/client/shell/NavRail.tsx` — nav links (Chats, Search, Brain, Contacts, Import, Settings) with active state, a live-connection indicator (from `useStatus`), and a brain "run due" badge that links to `/brain`
- [ ] 2.5 Create `src/client/shell/AppShell.tsx` — topbar (brand, local badge, refresh, theme) + `NavRail` + `OnboardingBanner` + `ToastHost` + `RouteErrorBoundary` wrapping `<Outlet/>`
- [ ] 2.6 Create `src/client/routes.tsx` — `<Routes>` with the `AppShell` layout route and `React.lazy` page children inside `<Suspense>`; `/` → `/chats`; a catch-all not-found route with a link to `/chats`
- [ ] 2.7 Reduce `src/client/App.tsx` to the shell composition: `<ToastProvider><StatusProvider><BrowserRouter><AppRoutes/></BrowserRouter></StatusProvider></ToastProvider>`; keep `main.tsx` mounting `<App/>` inside the top-level `AppErrorBoundary`
- [ ] 2.8 Temporarily render each page as a stub so the app builds and every route resolves before surfaces are moved; `npm run build` green

## 3. Chats and thread surface (`/chats`, `/chats/:id`)

- [ ] 3.1 Create `src/client/pages/chats/messageRender.tsx` — move `renderMentions`/`renderInline`/`renderInlineText`/`renderRichText` and thread-grouping helpers (`groupMessagesByDay`, `sortMessagesChronologically`, `groupConsecutiveMedia`, `isGridMedia`, `sameGridRun`, `isSystemEvent`, `messagePlaceholder`, `humanizeMessageType`, `isNearBottom`)
- [ ] 3.2 Move the media components into `src/client/pages/chats/`: `MessageBubble`, `MediaGridBubble`, `MessageMediaView`, `AudioBubble`, `VideoBubble`, `LinkPreviewCard`, `MediaLightbox`, `EditHistoryModal`, `useInlinePlayer`, and their constants/helpers
- [ ] 3.3 Create `src/client/pages/chats/ChatList.tsx` — chat search/type/event-only filters + list + load-more + skeletons; a chat click navigates via `buildChatDeepLink(chat.id)`; the selected chat is derived from the `:id` route param
- [ ] 3.4 Create `src/client/pages/chats/ThreadView.tsx` — move the message pane: load newest window, older-scroll auto-load, jump/anchor window, `messageQuery`, SSE-follow via `useArchiveEvents` + `isNearBottom`, lightbox. Read `:id` and `?at` (`parseAnchorParam`); `?at` loads the context window and scrolls to the anchor; "Latest messages" navigates to `/chats/:id`
- [ ] 3.5 Create `src/client/pages/chats/ChatsPage.tsx` composing `ChatList` + `ThreadView` (two-pane), showing the empty-thread state when no `:id`
- [ ] 3.6 Delete the moved chat/thread/media code from `App.tsx`; wire the `/chats` and `/chats/:id` routes to `ChatsPage`; `npm run build` + `npm test` green

## 4. Search surface (`/search`)

- [ ] 4.1 Create `src/client/pages/search/SearchPage.tsx` — move the global search box, `GlobalSearchResults`, filters (sender/type/direction/after/before), debounced `searchArchive`, and reindex CTA; index/reindex state comes from `useStatus`
- [ ] 4.2 Make a result open via `navigate(buildChatDeepLink(chatId, messageId))` to `/chats/:id?at=<messageId>` instead of in-component panel switching
- [ ] 4.3 Move `renderSearchSnippet` alongside `SearchPage`; delete the search code from `App.tsx`; wire the `/search` route; `npm run build` green

## 5. Contacts surface (`/contacts`) and single-entry SPA

- [ ] 5.1 Create `src/client/pages/contacts/GoogleContactsPanel.tsx` (moved from `App.tsx`), driven by `useStatus`/`useToast`
- [ ] 5.2 Create `src/client/pages/contacts/WaContactsView.tsx` from `waContacts/WaContactsPage.tsx` with its own topbar/shell removed (the app shell provides chrome); keep importing the pure `filterContacts` from its current path so `tests/waContacts*.test.ts` are untouched
- [ ] 5.3 Create `src/client/pages/contacts/ContactsPage.tsx` composing the Google panel + wa.db viewer; wire the `/contacts` route
- [ ] 5.4 Remove the second Vite entry: delete `wa-contacts.html` and `src/client/waContacts/main.tsx`, and drop the `waContacts` input from `vite.config.ts` `rollupOptions.input`; replace the old `href="/wa-contacts.html"` link with a `/contacts` nav/route link
- [ ] 5.5 `npm run build` green (single-entry SPA); `npm test` green (contacts filter tests still pass)

## 6. Brain surface (`/brain`)

- [ ] 6.1 Create `src/client/pages/brain/BrainPanel.tsx` (moved) — provider probe/enable/disable/set-model, run (model/extractive, maxChats), owner, reset; driven by `useStatus`/`useToast`
- [ ] 6.2 Create `src/client/pages/brain/MemoryPanel.tsx` (moved) — memory REM run/preview, query, citation resolution, Codex provider enable/disable
- [ ] 6.3 Create `src/client/pages/brain/BrainPage.tsx` composing `BrainPanel` + `MemoryPanel`; wire the `/brain` route; delete the moved code from `App.tsx`; `npm run build` green

## 7. Settings surface (`/settings`)

- [ ] 7.1 Create `src/client/pages/settings/StatusPanel.tsx` (moved) — archive counts, init-db, cleanup
- [ ] 7.2 Create `src/client/pages/settings/LivePanel.tsx` (moved) — link/pause/resume/unlink, gaps + retry, media retry, live progress; `PairingModal` renders from here (or the shell) and its poll uses `useStatus`
- [ ] 7.3 Create `src/client/pages/settings/SettingsPage.tsx` composing Archive + Live sections + theme; wire the `/settings` route; delete the moved code from `App.tsx`; `npm run build` green

## 8. Import surface with sub-routes (`/import`, `/import/key`, `/import/mode`, `/import/run`)

- [ ] 8.1 Create `src/client/pages/import/ImportPage.tsx` — the wizard container mapping steps to sub-routes; holds transient wizard state (backup path, manifest, key, verification, mode) as page state
- [ ] 8.2 Split the wizard steps into components under `pages/import/` (folder, key, mode, run/progress) using the existing `ImportWizard`/`ImportProgress`/`WizardActions`/`DetectionSummary`/`OverrideInput` logic verbatim
- [ ] 8.3 Reattach the active job on `/import/run` via `getCurrentImportJob()` and render `ImportProgress`; on completion refresh status + chat list via `useStatus`
- [ ] 8.4 Add step guards: `/import` redirects to `/import/run` when a job is active; `/import/key` and `/import/mode` redirect to `/import` when their prerequisite (selected backup / verified key) is absent and no job is active
- [ ] 8.5 Replace all `setImportWizardOpen(true)` entry points (onboarding, live panel, import launcher) with navigation to `/import`; wire the `/import*` routes; delete the wizard code from `App.tsx`; `npm run build` green

## 9. Reduce App.tsx to a shell and remove dead code

- [ ] 9.1 Confirm `App.tsx` contains only the provider + router composition (no surface JSX, no page state, no data-loading handlers); move or delete any remaining helpers
- [ ] 9.2 Remove now-unused imports/exports across `api.ts` consumers and delete dead code; ensure no `App`-local state remains that a page needs
- [ ] 9.3 `npm run build` (tsc + vite) green with no unused-symbol or type errors; `npm test` green

## 10. Checkpoint verification

- [ ] 10.1 Build the client and run the server on a non-default port against this worktree's own `.wapp-brain/` (never port 3600, never the live DB); load the app in a browser
- [ ] 10.2 Verify every surface is reachable at its own URL and reload-safe: reload on `/chats`, `/chats/:id`, `/search`, `/brain`, `/contacts`, `/import`, `/settings` each lands on that surface
- [ ] 10.3 Verify a search hit navigates to `/chats/:id?at=<messageId>` and opens the thread centered on the hit, and that reloading that URL reproduces the centered window
- [ ] 10.4 Verify mid-import reload returns to `/import/run` with live progress (reattached job); verify browser back/forward move between surfaces
- [ ] 10.5 Confirm async operations show progress and failures surface as toasts + console (never silent); confirm `App.tsx` is a shell and the full `npm test` suite is green
