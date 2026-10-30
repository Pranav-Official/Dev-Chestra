import { BarChart3 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Topbar } from "../shell/Topbar.js";
import "../styles/settings.css";
import { UsagePanel } from "./UsagePanel.js";

export function SettingsPage() {
  const { pid = "" } = useParams();
  const usagePath = pid !== "" ? `/p/${pid}/settings/usage` : "/settings/usage";
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
              <p>Token and cost analytics across runs.</p>
            </div>
          </div>
          <div className="settings-layout">
            <nav aria-label="Settings sections" className="card settings-nav">
              <Link to={usagePath} aria-current="page" className="nav-item active">
                <BarChart3 size={15} aria-hidden="true" />
                <span>Usage</span>
              </Link>
            </nav>
            <section aria-label="Usage settings" className="settings-main">
              <UsagePanel />
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
