import type { CliListItem, ProviderStatusItem } from "@devchestra/api";
import { PROD_CLI_LABELS, PROD_CLIS, type ProdCliId } from "@devchestra/schema";
import { RefreshCw } from "lucide-react";
import { classifyError } from "../../api/client.js";
import {
  useProbeProvider,
  useProviderStatuses,
  useProviders,
  useSetProviderEnabled,
} from "../../api/hooks.js";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import { Switch } from "../../ui/Switch.js";
import { InlineError, LoadingState } from "../../ui/states.js";
import "../../styles/settings-providers.css";

const OFF_TEXT = "Off: hidden from agent nodes; runs that use it are blocked.";
const LAST_ON_TEXT = "At least one provider must stay on";

function statusText(status: ProviderStatusItem | undefined): string {
  if (status === undefined) return "Unknown";
  switch (status.state) {
    case "ready":
      if (status.version === null || status.version === "") return "Ready";
      return /^\d/u.test(status.version)
        ? `Ready · v${status.version}`
        : `Ready · ${status.version}`;
    case "notInstalled":
      return "Not installed";
    case "error":
      return "Check failed";
    default:
      return "Unknown";
  }
}

function statusTone(status: ProviderStatusItem | undefined): string {
  if (status?.state === "ready") return "green";
  if (status?.state === "notInstalled" || status?.state === "error") return "amber";
  return "";
}

export function ProvidersPanel() {
  const providers = useProviders();
  const statuses = useProviderStatuses();
  const setEnabled = useSetProviderEnabled();
  const probe = useProbeProvider();

  const apiById = new Map<string, CliListItem>(
    (providers.data?.clis ?? []).map((entry) => [entry.id, entry]),
  );
  const statusList: ProviderStatusItem[] = statuses.isError ? [] : (statuses.data?.statuses ?? []);
  const statusById = new Map<string, ProviderStatusItem>(
    statusList.map((entry) => [entry.id, entry]),
  );
  // Without the server the static registry is shown, all on, and nothing can change.
  const unreachable = providers.isError;
  const rows = PROD_CLIS.map((id) => {
    const entry = apiById.get(id);
    return {
      id,
      label: entry?.label ?? PROD_CLI_LABELS[id],
      enabled: entry?.enabled ?? true,
    };
  });
  const enabledCount = rows.filter((row) => row.enabled).length;

  const rowError = (id: ProdCliId): string | null => {
    if (setEnabled.isError && setEnabled.variables?.cli === id) {
      return classifyError(setEnabled.error).message;
    }
    if (probe.isError && probe.variables === id) {
      return classifyError(probe.error).message;
    }
    return null;
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <h2>Providers</h2>
        <p className="faint">
          Choose which coding-agent CLIs DevChestra can use. Turned-off providers are hidden from
          agent nodes, and runs that use them are blocked.
        </p>
      </div>
      {unreachable ? (
        <InlineError message="Couldn't reach DevChestra. Showing defaults; changes are disabled." />
      ) : null}
      {providers.isPending ? (
        <LoadingState label="Loading providers…" />
      ) : (
        <div className="card">
          <ul aria-label="Providers" className="provider-list">
            {rows.map((row) => {
              const status = statusById.get(row.id);
              const retesting = probe.isPending && probe.variables === row.id;
              const checking = retesting || statuses.isPending;
              const detail =
                status?.state === "error" || status?.state === "notInstalled"
                  ? status.detail
                  : undefined;
              const lastOn = row.enabled && enabledCount === 1;
              const error = rowError(row.id);
              return (
                <li
                  key={row.id}
                  data-testid={`provider-row-${row.id}`}
                  className={`provider-row${row.enabled ? "" : " off"}`}
                >
                  <span className="provider-tile">
                    <ProviderIcon cli={row.id} size={20} />
                  </span>
                  <div className="provider-main">
                    <div className="provider-name-line">
                      <span className="provider-name">{row.label}</span>
                      <span
                        data-testid={`provider-status-${row.id}`}
                        className={`pill ${checking ? "" : statusTone(status)}`}
                        title={status?.detail}
                      >
                        {checking ? "Checking…" : statusText(status)}
                      </span>
                    </div>
                    {row.enabled ? (
                      detail === undefined ? null : (
                        <p className="provider-secondary">{detail}</p>
                      )
                    ) : (
                      <p className="provider-secondary">{OFF_TEXT}</p>
                    )}
                    {error === null ? null : (
                      <p className="provider-error" role="alert">
                        {error}
                      </p>
                    )}
                  </div>
                  <div className="provider-actions">
                    <button
                      type="button"
                      className="btn icon sm ghost"
                      aria-label={`Re-test ${row.label}`}
                      title={`Re-test ${row.label}`}
                      data-testid={`provider-retest-${row.id}`}
                      disabled={unreachable || retesting}
                      onClick={() => probe.mutate(row.id)}
                    >
                      <RefreshCw
                        size={14}
                        aria-hidden="true"
                        className={retesting ? "provider-spin" : undefined}
                      />
                    </button>
                    <Switch
                      checked={row.enabled}
                      label={row.enabled ? `Turn off ${row.label}` : `Turn on ${row.label}`}
                      disabled={unreachable || lastOn}
                      {...(lastOn ? { title: LAST_ON_TEXT } : {})}
                      testId={`provider-switch-${row.id}`}
                      onChange={(next) => setEnabled.mutate({ cli: row.id, enabled: next })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
