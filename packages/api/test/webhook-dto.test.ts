import { describe, expect, it } from "vitest";
import {
  executionSettingsSchema,
  webhookSettingsSchema,
  webhookTriggerResponseSchema,
  webhookTriggerStatusSchema,
} from "../src/index.js";

const status = {
  supported: true,
  armed: true,
  state: "current",
  hookId: "whk_abc",
  url: "http://127.0.0.1:4899/webhooks/whk_abc",
  armedRevision: "rev",
  armedAt: 1,
  lastDeliveryAt: null,
  refreshError: null,
  issues: [],
};

describe("webhook DTOs", () => {
  it("accepts a trigger status and rejects unknown keys", () => {
    expect(webhookTriggerStatusSchema.safeParse(status).success).toBe(true);
    expect(webhookTriggerStatusSchema.safeParse({ ...status, state: "paused" }).success).toBe(
      false,
    );
    expect(webhookTriggerStatusSchema.safeParse({ ...status, token: "leak" }).success).toBe(false);
  });

  it("returns the secret only through the arm and rotate response shape", () => {
    const secret = "0123456789abcdef0123456789abcdef01234567";
    const withSecret = { status, secret };
    expect(webhookTriggerResponseSchema.safeParse(withSecret).success).toBe(true);
    expect(webhookTriggerResponseSchema.safeParse({ status, secret: null }).success).toBe(true);
    expect(webhookTriggerStatusSchema.safeParse(withSecret).success).toBe(false);
  });

  it("accepts only the 40-character hex secret GitHub's documentation suggests", () => {
    const wrap = (secret: string) => ({ status, secret });
    expect(webhookTriggerResponseSchema.safeParse(wrap("dcws_" + "a".repeat(43))).success).toBe(
      false,
    );
    expect(webhookTriggerResponseSchema.safeParse(wrap("A".repeat(40))).success).toBe(false);
    expect(webhookTriggerResponseSchema.safeParse(wrap("f".repeat(39))).success).toBe(false);
    expect(webhookTriggerResponseSchema.safeParse(wrap("f".repeat(40))).success).toBe(true);
  });

  it("bounds execution settings to the documented ranges", () => {
    expect(
      executionSettingsSchema.safeParse({ maxConcurrentRuns: 2, maxQueueDepth: 100 }).success,
    ).toBe(true);
    expect(
      executionSettingsSchema.safeParse({ maxConcurrentRuns: 0, maxQueueDepth: 100 }).success,
    ).toBe(false);
    expect(
      executionSettingsSchema.safeParse({ maxConcurrentRuns: 33, maxQueueDepth: 100 }).success,
    ).toBe(false);
    expect(
      executionSettingsSchema.safeParse({ maxConcurrentRuns: 2, maxQueueDepth: 9 }).success,
    ).toBe(false);
    expect(
      executionSettingsSchema.safeParse({ maxConcurrentRuns: 2, maxQueueDepth: 1001 }).success,
    ).toBe(false);
  });

  it("accepts a null public base URL and rejects overlong values", () => {
    expect(webhookSettingsSchema.safeParse({ publicBaseUrl: null }).success).toBe(true);
    expect(
      webhookSettingsSchema.safeParse({ publicBaseUrl: `https://${"a".repeat(2100)}.example` })
        .success,
    ).toBe(false);
  });
});
