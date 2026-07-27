import { ArrowRight, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStatus } from "../state/StatusContext";
import { useToast } from "../state/ToastContext";

// First-run guided-setup hint. Cross-cutting and status-driven, it renders in the
// shell only while a setup action remains (import → link → resume). It is a slim,
// dismissible strip rather than a full-height card so it never dominates a
// surface; its CTA routes to the owning surface or opens the pairing flow.
const CTA: Record<string, string> = {
  import_backup: "Import backup",
  link_whatsapp: "Link WhatsApp",
  resume_sync: "Resume sync",
  reconnect: "Reconnect",
  repair_link: "Re-pair WhatsApp"
};

export function OnboardingBanner() {
  const navigate = useNavigate();
  const { status, openLink, openResume } = useStatus();
  const { setNotice } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const setup = status?.setup;
  const primaryAction = setup?.primaryAction;

  // Demo instances replace the real-data setup ladder (import → link → resume
  // is meaningless against synthetic data) with a one-time notice.
  const demo = Boolean(status?.demo);
  const demoNoticeShown = useRef(false);
  useEffect(() => {
    if (demo && !demoNoticeShown.current) {
      demoNoticeShown.current = true;
      setNotice("Demo instance: everything here is synthetic sample data. Your real workspace is untouched.");
    }
  }, [demo, setNotice]);

  if (demo || !setup || !primaryAction || !(primaryAction in CTA) || dismissed) {
    return null;
  }

  const onCta = () => {
    if (primaryAction === "import_backup") navigate("/import");
    else if (primaryAction === "resume_sync") void openResume();
    else void openLink();
  };

  return (
    <div className="onboardingBar">
      <Sparkles size={15} className="onboardingBarIcon" />
      <div className="onboardingBarText">
        <strong>{setup.label ?? "Guided setup"}</strong>
        <span>{setup.description}</span>
      </div>
      <button className="onboardingBarCta" type="button" onClick={onCta}>
        {CTA[primaryAction]}
        <ArrowRight size={14} />
      </button>
      <button className="onboardingBarDismiss" type="button" aria-label="Dismiss setup hint" onClick={() => setDismissed(true)}>
        <X size={15} />
      </button>
    </div>
  );
}
