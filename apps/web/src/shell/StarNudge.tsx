import { Star } from "lucide-react";
import { useEffect, useState } from "react";

export const REPO_URL = "https://github.com/Pranav-Official/Dev-Chestra";

const FIRST_SEEN_KEY = "devchestra.firstSeen";
const DISMISSED_KEY = "devchestra.starDismissed";
const SHOW_AFTER_MS = 10 * 60_000;
const LEAVE_MS = 180;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // UI preference only; without storage the nudge simply never shows.
  }
}

// lucide dropped brand icons, so the GitHub mark is drawn here.
export function GithubMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Shown once, 10 minutes after the first load in this browser; clicking it hides it for good.
export function StarNudge() {
  const [due, setDue] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (read(DISMISSED_KEY)) return;
    let firstSeen = Number(read(FIRST_SEEN_KEY));
    if (!Number.isFinite(firstSeen) || firstSeen <= 0) {
      firstSeen = Date.now();
      write(FIRST_SEEN_KEY, String(firstSeen));
    }
    if (read(FIRST_SEEN_KEY) === null) return;
    const check = () => {
      if (document.visibilityState === "visible" && Date.now() - firstSeen >= SHOW_AFTER_MS)
        setDue(true);
    };
    check();
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  if (!due) return null;

  const dismiss = () => {
    write(DISMISSED_KEY, "1");
    setLeaving(true);
    window.setTimeout(() => setDue(false), LEAVE_MS);
  };

  return (
    <a
      className={`star-nudge${leaving ? " leaving" : ""}`}
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={dismiss}
    >
      <Star size={14} aria-hidden="true" />
      <span>
        Enjoying DevChestra? <strong>Star it on GitHub</strong>
      </span>
    </a>
  );
}
