import type { EventEnvelope } from "@devchestra/core";

export type EventListener = (event: EventEnvelope) => void;

/**
 * In-process fan-out. publish runs only after the appending transaction commits,
 * in event order. A throwing subscriber never affects the others or the store.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(events: readonly EventEnvelope[]): void {
    for (const event of events) {
      for (const listener of [...this.#listeners]) {
        try {
          listener(event);
        } catch {
          // Subscribers are observers; a bug there must not fail a commit.
        }
      }
    }
  }
}
