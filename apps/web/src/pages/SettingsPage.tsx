import { Link, useLocation, useParams } from "react-router-dom";
import { Topbar } from "../shell/Topbar.js";
import { ProvidersPanel } from "./settings/ProvidersPanel.js";
import { SETTINGS_SECTIONS, settingsPath } from "./settings/sections.js";
import { UsagePanel } from "./UsagePanel.js";

export function SettingsPage() {
  const { pid = "" } = useParams();
  const location = useLocation();
  // Usage is the fallback page, as it was before the Providers page existed.
  const active =
    SETTINGS_SECTIONS.find((entry) => location.pathname.endsWith(`/settings/${entry.id}`)) ??
    SETTINGS_SECTIONS[1];
  const crumbs =
    pid !== ""
      ? [
          { label: "Project", to: `/p/${pid}/workflows` },
          { label: "Settings" },
          { label: active.label },
        ]
      : [{ label: "Settings" }, { label: active.label }];

  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        <div className="page">
          <div className="page-head">
            <div className="grow">
              <h1>Settings</h1>
              <p>Providers, token use and cost.</p>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 24, alignItems: "flex-start" }}>
            <nav
              aria-label="Settings sections"
              className="card"
              style={{ flex: "0 0 180px", padding: 6 }}
            >
              {SETTINGS_SECTIONS.map((entry) => {
                const current = entry.id === active.id;
                return (
                  <Link
                    key={entry.id}
                    to={settingsPath(pid, entry.id)}
                    aria-current={current ? "page" : undefined}
                    className={`nav-item${current ? " active" : ""}`}
                  >
                    <entry.icon size={15} aria-hidden="true" />
                    <span>{entry.label}</span>
                  </Link>
                );
              })}
            </nav>
            <section
              aria-label={`${active.label} settings`}
              style={{ flex: "1 1 540px", minWidth: 0 }}
            >
              {active.id === "providers" ? <ProvidersPanel /> : <UsagePanel />}
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
