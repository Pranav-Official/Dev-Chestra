import { RelayError } from "@relay/core";
import { describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  MAX_RESPONSE_BYTES,
  parseRetryAfterMs,
  readCappedText,
} from "../src/http.js";

describe("assertAllowedUrl", () => {
  it("allows https hosts", () => {
    expect(assertAllowedUrl("https://api.typesafe.ai/v1/systemone", false).host).toBe(
      "api.typesafe.ai",
    );
  });

  it("refuses plain http unless it is an injected loopback override", () => {
    expect(assertAllowedUrl("http://127.0.0.1:9/x", true).hostname).toBe("127.0.0.1");
    expect(() => assertAllowedUrl("http://127.0.0.1:9/x", false)).toThrowError(RelayError);
    expect(() => assertAllowedUrl("http://example.com/x", true)).toThrowError(RelayError);
    expect(() => assertAllowedUrl("file:///etc/passwd", true)).toThrowError(RelayError);
    expect(() => assertAllowedUrl("::not a url::", false)).toThrowError(RelayError);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds, dates and garbage", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("nonsense")).toBeNull();
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).not.toBeNull();
    expect(parsed as number).toBeGreaterThan(0);
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
});

describe("readCappedText", () => {
  it("reads small bodies and rejects oversized ones", async () => {
    const okRes = new Response("{}", { headers: { "content-length": "2" } });
    await expect(readCappedText(okRes, {}, MAX_RESPONSE_BYTES)).resolves.toBe("{}");

    const lying = new Response("{}", {
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    });
    await expect(readCappedText(lying, {}, MAX_RESPONSE_BYTES)).rejects.toThrowError(RelayError);

    const big = new Response("x".repeat(300));
    await expect(readCappedText(big, {}, 100)).rejects.toThrowError(/byte cap/);
  });
});
