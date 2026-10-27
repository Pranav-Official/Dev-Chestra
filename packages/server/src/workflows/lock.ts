const LOCKS = new Map<string, Promise<void>>();

/**
 * Serialize managed-file writes per project inside this process. This is not an
 * OS-level compare-and-swap: a non-cooperating cross-process writer can still
 * race the pre-commit revision check. Such a race is normally reported as 409;
 * do not claim an absolute guarantee against external editors.
 */
export async function withProjectLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  LOCKS.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (LOCKS.get(key) === chained) {
      LOCKS.delete(key);
    }
  }
}
