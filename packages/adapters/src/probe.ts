import { runCommand } from "./command.js";
import { buildChildEnv } from "./env.js";
import { clip } from "./parsers.js";
import type { CliId, ProbeCtx, ProbeResult } from "./types.js";

export async function probeVersion(
  id: CliId,
  bin: string,
  ctx: ProbeCtx,
  signal: AbortSignal,
  args: string[] = ["--version"],
): Promise<ProbeResult> {
  try {
    const result = await runCommand(
      {
        cmd: ctx.bin ?? bin,
        args,
        cwd: process.cwd(),
        env: ctx.env ?? buildChildEnv(id, { base: process.env }),
        timeoutMs: ctx.timeoutMs ?? 10_000,
      },
      {},
      signal,
    );
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(text);
    const detail = clip(text.split("\n")[0] ?? "", 512);
    if (result.exitCode !== 0) {
      return { ok: false, version: match?.[1] ?? null, detail };
    }
    return match === null
      ? { ok: true, version: null, detail }
      : { ok: true, version: match[1] ?? null, detail };
  } catch (error) {
    return {
      ok: false,
      version: null,
      detail: clip(error instanceof Error ? error.message : String(error), 512),
    };
  }
}
