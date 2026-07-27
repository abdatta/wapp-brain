import { lazy } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";

// Route-level code splitting: each surface is its own lazily-loaded chunk, loaded
// on first navigation behind the shell's Suspense fallback. Pages use named
// exports, so map them to a default for React.lazy.
const ChatsPage = lazy(() => import("./pages/chats/ChatsPage").then((m) => ({ default: m.ChatsPage })));
const SearchPage = lazy(() => import("./pages/search/SearchPage").then((m) => ({ default: m.SearchPage })));
const BrainPage = lazy(() => import("./pages/brain/BrainPage").then((m) => ({ default: m.BrainPage })));
const BrainEvalPage = lazy(() => import("./pages/brain/BrainEvalPage").then((m) => ({ default: m.BrainEvalPage })));
const CommitmentsPage = lazy(() => import("./pages/brain/CommitmentsPage").then((m) => ({ default: m.CommitmentsPage })));
const BrainMutedPage = lazy(() => import("./pages/brain/MutedPage").then((m) => ({ default: m.MutedPage })));
const BrainDocsPage = lazy(() => import("./pages/brain/DocsPage").then((m) => ({ default: m.BrainDocsPage })));
const BrainDocPage = lazy(() => import("./pages/brain/DocPage").then((m) => ({ default: m.BrainDocPage })));
const BrainRunsPage = lazy(() => import("./pages/brain/RunsPage").then((m) => ({ default: m.BrainRunsPage })));
const ContactsPage = lazy(() => import("./pages/contacts/ContactsPage").then((m) => ({ default: m.ContactsPage })));
const PeoplePage = lazy(() => import("./pages/people/PeoplePage").then((m) => ({ default: m.PeoplePage })));
const GraphPage = lazy(() => import("./pages/graph/GraphPage").then((m) => ({ default: m.GraphPage })));
const ImportPage = lazy(() => import("./pages/import/ImportPage").then((m) => ({ default: m.ImportPage })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));

function NotFound() {
  return (
    <div className="routeNotFound">
      <h2>Nothing here</h2>
      <p>That path doesn't map to a surface.</p>
      <Link to="/chats">Back to chats</Link>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/chats" replace />} />
        {/* ONE route, optional param — not two entries rendering the same
            component. Two entries are distinct positions in the route tree, so
            navigating `/chats` → `/chats/:id` unmounted and remounted the page
            and threw away all of its filter state: the search box, the type
            filter, the event-only toggle, the muted fold, and the loaded list
            (which is why an opened chat then resolved as "Unresolved contact" —
            it was no longer in the list to look up). */}
        <Route path="chats/:id?" element={<ChatsPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="brain" element={<BrainPage />} />
        <Route path="brain/eval" element={<BrainEvalPage />} />
        <Route path="brain/commitments" element={<CommitmentsPage />} />
        <Route path="brain/muted" element={<BrainMutedPage />} />
        <Route path="brain/pages" element={<BrainDocsPage />} />
        <Route path="brain/pages/:docId" element={<BrainDocPage />} />
        <Route path="brain/runs" element={<BrainRunsPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="import/key" element={<ImportPage />} />
        <Route path="import/mode" element={<ImportPage />} />
        <Route path="import/run" element={<ImportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
