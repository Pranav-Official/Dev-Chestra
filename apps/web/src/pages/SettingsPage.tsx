import { BarChart3 } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Topbar } from "../shell/Topbar.js";
import { UsagePanel } from "./UsagePanel.js";

export function SettingsPage() {
  const { pid = "" } = useParams();
  const location = useLocation();
  const usagePath = pid !== "" ? `/p/${pid}/settings/usage` : "/settings/usage";
  const active = location.pathname.endsWith("/settings/usage");
  const crumbs =
    pid !== ""
      ? [{ label: "Project", to: `/p/${pid}/workflows` }, { label: "Settings" }, { label: "Usage" }]
      : [{ label: "Settings" }, { label: "Usage" }];

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        <div className="page">
          <div className="page-head">
            <div className="grow">
              <h1>Settings</h1>
              <p>Workspace settings. Token and cost analytics, live.</p>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 24, alignItems: "flex-start" }}>
            <nav
              aria-label="Settings sections"
              className="card"
              style={{ flex: "0 0 180px", padding: 6 }}
            >
              <Link
                to={usagePath}
                aria-current={active ? "page" : undefined}
                className={`nav-item${active ? " active" : ""}`}
              >
                <BarChart3 size={15} aria-hidden="true" />
                <span>Usage</span>
              </Link>
            </nav>
            <section
              aria-label="Usage settings"
              style={{ flex: "1 1 540px", minWidth: 0 }}
            >
              <UsagePanel />
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
