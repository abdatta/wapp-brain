import { useEffect, useState } from "react";
import type { GoogleContactsStatus } from "../../../shared/types";
import { disconnectGoogleContacts, getGoogleContactsStatus, syncGoogleContacts } from "../../api";
import { GoogleContactsPanel } from "../../panels";
import { useStatus } from "../../state/StatusContext";
import { useToast } from "../../state/ToastContext";
import { WaContactsView } from "./WaContactsView";

// Contact enrichment surface: Google Contacts sync/disconnect plus the wa.db
// viewer. Name improvements from a sync propagate to the chat list through the
// archive-updated SSE stream the shell subscribes to.
export function ContactsPage() {
  const { setNotice, setError } = useToast();
  const { refreshStatus } = useStatus();
  const [googleStatus, setGoogleStatus] = useState<GoogleContactsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getGoogleContactsStatus()
      .then(setGoogleStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not read Google Contacts status."));
  }, [setError]);

  async function handleSync() {
    setBusy(true);
    setError(null);
    try {
      const response = await syncGoogleContacts();
      setGoogleStatus(response.status);
      setNotice(`Google Contacts synced: ${response.result.improvedNames.toLocaleString()} names improved.`);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google Contacts sync failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect Google Contacts? Imported names will remain in your local archive.")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await disconnectGoogleContacts();
      setGoogleStatus(response.status);
      setNotice(response.revoked ? "Google Contacts disconnected and access revoked." : "Google Contacts disconnected locally.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect Google Contacts.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="contactsPage">
      <div className="toolHeader">
        <span className="eyebrow">Contacts</span>
        <p>Resolve phone-number contacts to names. Everything stays in your local archive.</p>
      </div>
      <GoogleContactsPanel
        status={googleStatus}
        busy={busy}
        onSync={() => void handleSync()}
        onDisconnect={() => void handleDisconnect()}
      />
      <WaContactsView />
    </div>
  );
}
