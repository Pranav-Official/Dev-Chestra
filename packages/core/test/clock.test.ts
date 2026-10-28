import { describe, expect, it } from "vitest";
import { DevChestraError, FakeClock } from "../src/index.js";

describe("FakeClock", () => {
  it("resolves sleeps in due order", async () => {
    const clock = new FakeClock(1_000);
    const order: string[] = [];
    const late = clock.sleep(100).then(() => order.push("late"));
    const early = clock.sleep(25).then(() => order.push("early"));

    clock.advance(24);
    expect(order).toEqual([]);
    expect(clock.pendingSleepCount()).toBe(2);

    clock.advance(1);
    await early;
    expect(order).toEqual(["early"]);

    clock.advance(75);
    await late;
    expect(order).toEqual(["early", "late"]);
    expect(clock.now()).toBe(1_100);
    expect(clock.pendingSleepCount()).toBe(0);
  });

  it("resolves zero-delay sleeps on the next advance without moving earlier", async () => {
    const clock = new FakeClock(50);
    const done = clock.sleep(0);
    clock.advance(0);
    await done;
    expect(clock.now()).toBe(50);
  });

  it("rejects an aborted sleep and removes it from the timer set", async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const sleeping = clock.sleep(100, controller.signal);
    controller.abort("stop");
    await expect(sleeping).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(clock.pendingSleepCount()).toBe(0);
    clock.advance(100);
    expect(clock.now()).toBe(100);
  });

  it("rejects when the signal is already aborted", async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    controller.abort();
    await expect(clock.sleep(10, controller.signal)).rejects.toBeInstanceOf(DevChestraError);
  });

  it("rejects invalid durations", () => {
    const clock = new FakeClock(0);
    expect(() => clock.advance(-1)).toThrow(DevChestraError);
    expect(() => clock.sleep(Number.NaN)).toThrow(DevChestraError);
  });
});
