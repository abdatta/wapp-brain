import { FlaskConical, Loader2, MessageCircle, RefreshCcw, ShieldCheck } from "lucide-react";
import { Suspense, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PairingModal } from "../panels";
import { routeStateKey } from "../lib/routeState";
import { useStatus } from "../state/StatusContext";
import { useToast } from "../state/ToastContext";
import { NavRail } from "./NavRail";
import { OnboardingBanner } from "./OnboardingBanner";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { ToastHost } from "./ToastHost";

// The persistent app shell: topbar, primary nav, onboarding banner, toast host,
// and a per-route error boundary around the lazily-loaded page outlet. Owns no
// page state; cross-cutting state comes from the status/toast contexts. The
// pairing modal renders here so it is reachable from the onboarding banner and
// the settings live panel alike.
export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, refreshStatus, pairing, pairingOpen, closePairing, openLink } = useStatus();
  const { setNotice, setError } = useToast();
  const demo = Boolean(status?.demo);

  // Even a bare browser tab must be identifiable as demo vs real.
  useEffect(() => {
    document.title = demo ? "Wapp Brain — Demo" : "Wapp Brain";
  }, [demo]);

  // Handle the Google OAuth callback landing (server redirects to
  // `/?googleContacts=...`). Surface the outcome as a toast and route to the
  // contacts surface, stripping the query — no server change required.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("googleContacts")) {
      if (params.get("googleContacts") === "connected") setNotice("Google Contacts connected. Sync when ready.");
      if (params.get("googleContacts") === "error") setError(params.get("message") || "Google Contacts authorization failed.");
      navigate("/contacts", { replace: true });
    }
  }, [navigate, setNotice, setError]);

  return (
    <div className="appShell">
      <header className="topbar">
        <div className="brandBlock">
          <div className="brandMark">
            <MessageCircle size={20} />
          </div>
          <div>
            <h1>Wapp Brain</h1>
            <p>{demo ? "Synthetic demo archive" : "Local WhatsApp archive"}</p>
          </div>
        </div>
        <NavRail />
        <div className="topActions">
          {demo && (
            <span className="demoBadge" title={`Synthetic demo data — the real workspace is untouched.${status?.demoWorkspacePath ? ` Workspace: ${status.demoWorkspacePath}` : ""}`}>
              <FlaskConical size={16} />
              Demo data
            </span>
          )}
          <span className="localBadge">
            <ShieldCheck size={16} />
            127.0.0.1
          </span>
          <button className="iconButton" onClick={() => void refreshStatus()} title="Refresh status" aria-label="Refresh status">
            <RefreshCcw size={18} />
          </button>
        </div>
      </header>

      <OnboardingBanner />
      <ToastHost />

      <main className="routeOutlet">
        <RouteErrorBoundary key={routeStateKey(location.pathname)}>
          <Suspense
            fallback={
              <div className="routeLoading">
                <Loader2 className="spin" size={20} />
                <span>Loading…</span>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>

      {pairingOpen && <PairingModal pairing={pairing} onClose={closePairing} onRetry={() => void openLink()} />}
    </div>
  );
}
