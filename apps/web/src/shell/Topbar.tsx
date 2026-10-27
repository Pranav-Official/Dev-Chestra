import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusPill } from "../ui/StatusPill.js";
import { ThemeToggle } from "./ThemeToggle.js";

export interface Crumb {
  label: string;
  to?: string;
}

export function Topbar({
  crumbs,
  actions,
  status,
  readonly = false,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
  status?: { value: string; testId?: string };
  readonly?: boolean;
}) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumbs">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}:${crumb.to ?? "current"}`} className="row" style={{ gap: 6 }}>
            {index > 0 ? <ChevronRight size={12} className="faint" aria-hidden="true" /> : null}
            {crumb.to === undefined ? (
              <b aria-current="page">{crumb.label}</b>
            ) : (
              <Link to={crumb.to}>{crumb.label}</Link>
            )}
          </span>
        ))}
      </nav>
      <span className="sp" />
      {status ? (
        <StatusPill
          status={status.value}
          {...(status.testId === undefined ? {} : { testId: status.testId })}
        />
      ) : null}
      {readonly ? (
        <span className="readonly-chip" title="This viewer cannot change runs">
          Read-only
        </span>
      ) : null}
      {actions}
      <ThemeToggle />
    </header>
  );
}
