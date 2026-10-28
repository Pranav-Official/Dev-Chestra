import { type ServerStatus, serverStatus, stopServer } from "./server-control.js";

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function describeStatus(status: ServerStatus): string[] {
  const lines: string[] = [];
  if (status.state === "running") {
    lines.push(`devchestra is running (pid ${status.pid})`);
    lines.push(`  url      ${status.url}`);
    lines.push(`  data     ${status.dataDir}`);
    lines.push(`  version  ${status.version}`);
    if (status.uptimeMs !== undefined) lines.push(`  uptime   ${formatDuration(status.uptimeMs)}`);
    lines.push(
      `  runs     ${status.activeRuns === null || status.activeRuns === undefined ? "unknown" : `${status.activeRuns} active`}`,
    );
    if (status.projects !== null && status.projects !== undefined) {
      lines.push(`  projects ${status.projects}`);
    }
  } else if (status.state === "stopped") {
    lines.push("devchestra is not running");
    lines.push(`  data     ${status.dataDir}`);
  } else if (status.state === "stale") {
    lines.push("devchestra is not running (a leftover record from a crash or reboot was found)");
    lines.push(`  data     ${status.dataDir}`);
    lines.push("  run `devchestra stop` to clear it");
  } else {
    lines.push(`devchestra server record is ${status.state}: ${status.reason ?? ""}`.trim());
    lines.push(`  data     ${status.dataDir}`);
  }
  return lines;
}

/** Exit 0 when a server is running, 1 otherwise, so scripts can branch on it. */
export async function runStatus(dataDir: string, json: boolean): Promise<number> {
  const status = await serverStatus(dataDir);
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "status", ...status })}\n`);
  } else {
    process.stdout.write(`${describeStatus(status).join("\n")}\n`);
  }
  return status.state === "running" ? 0 : 1;
}

export async function runStop(
  dataDir: string,
  options: { force: boolean; timeoutMs: number; json: boolean },
): Promise<number> {
  const outcome = await stopServer(dataDir, { force: options.force, timeoutMs: options.timeoutMs });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ type: "stop", ...outcome })}\n`);
  } else if (outcome.result === "stopped") {
    process.stdout.write(
      outcome.killed
        ? `devchestra was killed (pid ${outcome.status.pid}); it did not exit on its own\n`
        : `devchestra stopped (pid ${outcome.status.pid})\n`,
    );
  } else if (outcome.result === "not-running") {
    process.stdout.write(
      outcome.cleanedStaleRecord
        ? "devchestra was not running; cleared a leftover record\n"
        : "devchestra is not running\n",
    );
  } else {
    process.stderr.write(`devchestra: ${outcome.reason}\n`);
  }
  return outcome.result === "stopped" || outcome.result === "not-running" ? 0 : 1;
}
