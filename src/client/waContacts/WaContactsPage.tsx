import { AlertTriangle, ArrowLeft, CheckCircle2, Eye, FileKey2, HardDrive, Loader2, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StatusSummary, WaContactsSummary } from "../../shared/types";
import { fetchWaContacts, getStatus, pickImportPath } from "../api";
import { filterWaContacts, paginateWaContacts, type WaContactsStatusFilter } from "./filterContacts";

const PAGE_SIZE = 50;

export function WaContactsPage() {
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [waPath, setWaPath] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WaContactsSummary | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WaContactsStatusFilter>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter]);

  const pickerAvailable = Boolean(status?.pickerAvailable);

  async function browseWaPath() {
    setError(null);
    const result = await pickImportPath("wa", waPath || null).catch(() => null);
    if (result?.path) {
      setWaPath(result.path);
      setSummary(null);
    }
  }

  async function view() {
    setBusy(true);
    setError(null);
    setSummary(null);
    setQuery("");
    setStatusFilter("all");
    try {
      const result = await fetchWaContacts({ waPath: waPath.trim(), key: key || null });
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read wa.db contacts.");
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(
    () => (summary ? filterWaContacts(summary.contacts, { query, status: statusFilter }) : []),
    [summary, query, statusFilter]
  );
  const paginated = useMemo(() => paginateWaContacts(filtered, page, PAGE_SIZE), [filtered, page]);

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandMark">
            <Users size={20} />
          </div>
          <div>
            <h1>wa.db contacts viewer</h1>
            <p>Side tool — local WhatsApp archive</p>
          </div>
        </div>
        <a className="iconButton" href="/" title="Back to Wapp Brain" aria-label="Back to Wapp Brain">
          <ArrowLeft size={18} />
        </a>
      </header>
      <main className="toolPage">
        <div className="toolHeader">
          <span className="eyebrow">
            <Users size={14} />
            Side tool
          </span>
          <p>
            Decrypt a wa.db / wa.db.crypt15 contacts sidecar locally and explore what's in it — which contacts have a
            resolved name and which are missing one — independent of your main archive.
          </p>
        </div>

        <section className="toolCard">
          {error && (
            <div className="wizardError">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          <div className="filePickRow">
            <div className="fileIcon">
              <HardDrive size={18} />
            </div>
            <div>
              <strong>wa.db / wa.db.crypt15</strong>
              <p>The contacts sidecar from your WhatsApp backup. Everything is read in place — nothing is uploaded.</p>
            </div>
            {pickerAvailable && (
              <button className="fileButton" type="button" onClick={() => void browseWaPath()} disabled={busy}>
                Browse…
              </button>
            )}
          </div>
          <label className="wizardField">
            <span>{pickerAvailable ? "Or type the wa.db path" : "wa.db path"}</span>
            <input
              value={waPath}
              onChange={(event) => {
                setWaPath(event.target.value);
                setSummary(null);
              }}
              autoComplete="off"
              placeholder="e.g. C:\\Backups\\WhatsApp\\wa.db.crypt15"
            />
          </label>
          <div className="keyBox">
            <FileKey2 size={20} />
            <div>
              <strong>Key stays local</strong>
              <p>Only needed if the file ends in .crypt15. The raw key is used only for this local operation and is never saved.</p>
            </div>
          </div>
          <label className="wizardField">
            <span>64-character backup key (only needed for .crypt15)</span>
            <input value={key} onChange={(event) => setKey(event.target.value)} type="password" autoComplete="off" placeholder="Paste key here" />
          </label>
          {busy && (
            <div className="wizardBusy">
              <Loader2 className="spin" size={16} />
              <span>Decrypting and reading contacts locally…</span>
            </div>
          )}
          <div className="wizardActions">
            <div className="wizardSecondaryActions" />
            <button className="primaryButton" type="button" onClick={() => void view()} disabled={busy || !waPath.trim()}>
              {busy ? <Loader2 className="spin" size={16} /> : <Eye size={16} />}
              View contacts
            </button>
          </div>
        </section>

        {summary && (
          <section className="toolCard">
            <div className="verifySuccess">
              <CheckCircle2 size={16} />
              <span>
                {summary.totalContacts} contacts total — {summary.resolvedCount} resolved, {summary.unresolvedCount} unresolved.
              </span>
            </div>
            <div className="waContactsFilters">
              <div className="searchBox">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name, number, or JID"
                />
              </div>
              <div className="segmented waContactsStatusFilter">
                {(["all", "resolved", "unresolved"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={statusFilter === option ? "active" : ""}
                    onClick={() => setStatusFilter(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className="waContactsTableWrap">
              <table className="waContactsTable">
                <thead>
                  <tr>
                    <th>JID</th>
                    <th>Number</th>
                    <th>Name</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.rows.map((contact) => (
                    <tr key={contact.jid}>
                      <td>{contact.jid}</td>
                      <td>{contact.number ?? "—"}</td>
                      <td>{contact.displayName ?? "—"}</td>
                      <td>
                        {contact.resolved ? (
                          <span className="detectionOk">
                            <CheckCircle2 size={14} /> Resolved
                          </span>
                        ) : (
                          <span className="detectionMissing">
                            <AlertTriangle size={14} /> Missing name
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {paginated.rows.length === 0 && <p className="emptyState">No contacts match this filter.</p>}
            </div>
            {filtered.length > 0 && (
              <div className="waContactsPagination">
                <span>
                  Showing {(paginated.page - 1) * PAGE_SIZE + 1}–{(paginated.page - 1) * PAGE_SIZE + paginated.rows.length} of{" "}
                  {paginated.total}
                </span>
                <div className="waContactsPaginationButtons">
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => setPage((current) => current - 1)}
                    disabled={paginated.page <= 1}
                  >
                    Prev
                  </button>
                  <span>
                    Page {paginated.page} of {paginated.pageCount}
                  </span>
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => setPage((current) => current + 1)}
                    disabled={paginated.page >= paginated.pageCount}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
