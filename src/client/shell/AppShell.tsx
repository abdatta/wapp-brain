import { Loader2, MessageCircle, Moon, RefreshCcw, ShieldCheck } from "lucide-react";
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
  const { refreshStatus, pairing, pairingOpen, closePairing, openLink } = useStatus();
  const { setNotice, setError } = useToast();

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
            <p>Local WhatsApp archive</p>
          </div>
        </div>
        <NavRail />
        <div className="topActions">
          <span className="localBadge">
            <ShieldCheck size={16} />
            127.0.0.1
          </span>
          <button className="iconButton" onClick={() => void refreshStatus()} title="Refresh status" aria-label="Refresh status">
            <RefreshCcw size={18} />
          </button>
          <button className="iconButton mutedIcon" title="Local dark theme" aria-label="Local dark theme">
            <Moon size={18} />
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
