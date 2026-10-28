import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where DevChestra keeps its database, locks and server metadata when `--data-dir` is not given.
 * `DEVCHESTRA_DATA_DIR` wins, then `$XDG_DATA_HOME/devchestra`, then `~/.local/share/devchestra`.
 * It is never a temp directory, so projects and run history survive a reboot.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DEVCHESTRA_DATA_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg !== "") return join(xdg, "devchestra");
  return join(homedir(), ".local", "share", "devchestra");
}
