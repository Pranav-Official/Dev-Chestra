import { RelayError } from "./error.js";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function cancelled(signal: AbortSignal): RelayError {
  return new RelayError(
    "E_CANCELLED",
    "Sleep cancelled",
    signal.reason === undefined ? {} : { cause: signal.reason },
  );
}

function assertDelay(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RelayError("E_VALIDATION", `Invalid sleep duration: ${String(ms)}`);
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    assertDelay(ms);
    if (signal?.aborted === true) return Promise.reject(cancelled(signal));
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(cancelled(signal as AbortSignal));
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

interface FakeSleep {
  due: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
}

export class FakeClock implements Clock {
  private current: number;
  private readonly sleeps: FakeSleep[] = [];

  constructor(start = 0) {
    if (!Number.isFinite(start)) {
      throw new RelayError("E_VALIDATION", `Invalid fake clock start: ${String(start)}`);
    }
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    assertDelay(ms);
    if (signal?.aborted === true) return Promise.reject(cancelled(signal));
    return new Promise<void>((resolve, reject) => {
      const entry: FakeSleep = {
        due: this.current + ms,
        resolve,
        reject,
        signal,
        onAbort: null,
      };
      if (signal !== undefined) {
        entry.onAbort = (): void => {
          this.remove(entry);
          reject(cancelled(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.sleeps.push(entry);
    });
  }

  advance(ms: number): void {
    assertDelay(ms);
    this.advanceTo(this.current + ms);
  }

  advanceTo(target: number): void {
    if (!Number.isFinite(target) || target < this.current) {
      throw new RelayError("E_VALIDATION", `Cannot advance fake clock to ${String(target)}`);
    }
    for (;;) {
      let nextIndex = -1;
      let nextDue = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.sleeps.length; i += 1) {
        const sleep = this.sleeps[i];
        if (sleep !== undefined && sleep.due <= target && sleep.due < nextDue) {
          nextIndex = i;
          nextDue = sleep.due;
        }
      }
      if (nextIndex === -1) break;
      const [sleep] = this.sleeps.splice(nextIndex, 1);
      if (sleep === undefined) break;
      this.current = Math.max(this.current, sleep.due);
      this.detach(sleep);
      sleep.resolve();
    }
    this.current = target;
  }

  pendingSleepCount(): number {
    return this.sleeps.length;
  }

  private detach(entry: FakeSleep): void {
    if (entry.signal !== undefined && entry.onAbort !== null) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
  }

  private remove(entry: FakeSleep): void {
    const index = this.sleeps.indexOf(entry);
    if (index !== -1) this.sleeps.splice(index, 1);
    this.detach(entry);
  }
}
