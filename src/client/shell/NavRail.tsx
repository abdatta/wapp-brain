import { Brain, MessageCircle, Search, Signal, SlidersHorizontal, Upload, Users } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useStatus } from "../state/StatusContext";

const NAV_ITEMS: { to: string; label: string; icon: ReactNode }[] = [
  { to: "/chats", label: "Chats", icon: <MessageCircle size={18} /> },
  { to: "/search", label: "Search", icon: <Search size={18} /> },
  { to: "/brain", label: "Brain", icon: <Brain size={18} /> },
  { to: "/contacts", label: "Contacts", icon: <Users size={18} /> },
  { to: "/import", label: "Import", icon: <Upload size={18} /> },
  { to: "/settings", label: "Settings", icon: <SlidersHorizontal size={18} /> }
];

// The primary navigation. Each surface is a route; the active surface is derived
// from the URL. Cross-cutting glances live here too: the live-session
// connection dot and a brain "run due" badge that links to /brain.
export function NavRail() {
  const { status, brainOverview } = useStatus();
  const liveState = status?.live?.session?.status ?? "not_configured";
  const runDue = Boolean(brainOverview?.scheduler.runDue);

  return (
    <nav className="navRail" aria-label="Primary">
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => `navItem ${isActive ? "active" : ""}`}>
          {item.icon}
          <span>{item.label}</span>
          {item.to === "/brain" && runDue && <span className="navBadge">run due</span>}
          {item.to === "/settings" && (
            <span className={`navHealthDot ${liveState === "connected" ? "healthy" : liveState === "logged_out" ? "needs_user_action" : "disconnected"}`} title={`Live: ${liveState.replaceAll("_", " ")}`} />
          )}
        </NavLink>
      ))}
    </nav>
  );
}
