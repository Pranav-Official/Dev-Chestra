import { AlertTriangle, FolderX, Inbox, LockKeyhole, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state-page" data-testid="loading-state" aria-busy="true" aria-live="polite">
      <div className="state-card" style={{ width: 360 }}>
        <div className="skeleton" style={{ width: "55%", height: 18 }} />
        <div className="skeleton" style={{ width: "100%" }} />
        <div className="skeleton" style={{ width: "82%" }} />
        <div className="skeleton" style={{ width: "64%" }} />
        <p className="faint">{label}</p>
      </div>
    </div>
  );
}

export function NetworkError({
  message = "The DevChestra server could not be reached.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-page" data-testid="network-error">
      <div className="state-card">
        <WifiOff size={28} aria-hidden="true" />
        <div className="title">Network error</div>
        <p>{message}</p>
        {onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function AuthState() {
  return (
    <div className="state-page" data-testid="auth-state">
      <div className="state-card">
        <LockKeyhole size={28} aria-hidden="true" />
        <div className="title">Open DevChestra from your terminal</div>
        <p>
          This browser does not have a DevChestra session. Run{" "}
          <span className="mono">devchestra start</span> in your terminal and open the URL it
          prints. The session stays in an HttpOnly cookie.
        </p>
      </div>
    </div>
  );
}

export function NotFoundState({
  title = "Not found",
  message = "That project or run does not exist.",
  backTo = "/",
  backLabel = "Back to projects",
}: {
  title?: string;
  message?: string;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="state-page" data-testid="not-found-state">
      <div className="state-card">
        <Inbox size={28} aria-hidden="true" />
        <div className="title">{title}</div>
        <p>{message}</p>
        <Link className="btn" to={backTo}>
          {backLabel}
        </Link>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty" data-testid="empty-state">
      <Inbox size={22} aria-hidden="true" />
      <h2 style={{ marginTop: 8 }}>{title}</h2>
      <p style={{ marginTop: 4 }}>{message}</p>
      {children}
    </div>
  );
}

export function MissingProjectBanner({ projectName }: { projectName: string }) {
  return (
    <div className="note amber" data-testid="missing-project-banner" role="status">
      <FolderX size={16} aria-hidden="true" />
      <div>
        <b>{projectName}</b> is registered, but its folder is missing. Run history is preserved.
        Re-link it from the CLI or the documented relink API. This read-only viewer cannot move the
        folder.
      </div>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="note red" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
