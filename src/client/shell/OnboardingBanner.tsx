import { useNavigate } from "react-router-dom";
import { OnboardingPanel } from "../panels";
import { useStatus } from "../state/StatusContext";

// First-run guided-setup banner. Cross-cutting and status-driven, it renders in
// the shell only while setup is still incomplete (there is a setup action left
// to progress the archive → live-sync flow) and hides once the archive is set up
// and syncing. Its CTAs navigate to the owning surfaces or open the pairing flow.
const SETUP_ACTIONS = new Set(["import_backup", "link_whatsapp", "resume_sync", "reconnect", "repair_link"]);

export function OnboardingBanner() {
  const navigate = useNavigate();
  const { status, liveProgress, openLink, openResume } = useStatus();
  const primaryAction = status?.setup?.primaryAction;

  if (!status?.setup || !primaryAction || !SETUP_ACTIONS.has(primaryAction)) {
    return null;
  }

  return (
    <div className="onboardingBannerHost">
      <OnboardingPanel
        status={status}
        busy={null}
        progress={liveProgress}
        onImport={() => navigate("/import")}
        onLink={() => void openLink()}
        onResume={() => void openResume()}
        onReviewGaps={() => navigate("/settings")}
      />
    </div>
  );
}
