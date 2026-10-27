import type { ExecStatus, RunStatus } from "@relay/core";
import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  Clock3,
  LoaderCircle,
  OctagonX,
  PauseCircle,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";

type AnyStatus = RunStatus | ExecStatus | string;

interface Meta {
  label: string;
  cls: string;
  Icon: typeof Circle;
  spin?: boolean;
}

const META: Record<string, Meta> = {
  queued: { label: "Queued", cls: "", Icon: CircleDashed },
  pending: { label: "Pending", cls: "", Icon: Circle },
  ready: { label: "Ready", cls: "blue", Icon: Clock3 },
  running: { label: "Running", cls: "blue", Icon: LoaderCircle, spin: true },
  validating: { label: "Validating", cls: "blue", Icon: LoaderCircle, spin: true },
  paused: { label: "Paused", cls: "amber", Icon: PauseCircle },
  waiting_quota: { label: "Waiting for quota", cls: "amber", Icon: Clock3 },
  waiting_approval: { label: "Waiting for approval", cls: "amber", Icon: ShieldQuestion },
  succeeded: { label: "Succeeded", cls: "green", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "red", Icon: TriangleAlert },
  rejected: { label: "Rejected", cls: "red", Icon: OctagonX },
  cancelled: { label: "Cancelled", cls: "", Icon: Ban },
  skipped: { label: "Skipped", cls: "", Icon: CircleSlash },
  interrupted: { label: "Interrupted", cls: "amber", Icon: TriangleAlert },
  error: { label: "Error", cls: "red", Icon: TriangleAlert },
};

export function statusLabel(status: AnyStatus): string {
  return META[status]?.label ?? status;
}

export function statusTone(status: AnyStatus): string {
  return META[status]?.cls ?? "";
}

export function StatusPill({
  status,
  testId,
  className = "",
}: {
  status: AnyStatus;
  testId?: string;
  className?: string;
}) {
  const meta = META[status] ?? { label: status, cls: "", Icon: Circle };
  const Icon = meta.Icon;
  return (
    <span
      className={`pill ${meta.cls} ${className}`.trim()}
      data-testid={testId}
      title={meta.label}
    >
      <Icon
        size={12}
        className={meta.spin ? "spin" : "ic"}
        aria-hidden="true"
        data-testid={testId ? `${testId}-icon` : undefined}
      />
      <span>{meta.label}</span>
    </span>
  );
}
