// Fake System One host for @relay/decisions integration tests.
//
// A loopback HTTP server that emulates the three decision presets from
// section 1 of the decision-node contract: bearer auth checks, bare (Jev)
// and Cloudflare-wrapped (`{ result }`) responses, plus failure scenarios
// (429 with Retry-After, 5xx, 4xx, malformed JSON, oversized body, refusals,
// slow responses, redirects). It records every decision request it receives
// so tests can assert the exact wire body.
//
// Fake credentials only. Never point this at a real provider, and never put
// a real key in here or in any test.
//
// Import from tests:
//
//   import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
//   const standin = await startStandin();
//   const client = createDecisionClient("typesafe-jev", {
//     env: { TYPESAFE_API_KEY: "test-typesafe-key", ... },
//     dotenvPath: null,
//     baseUrlOverride: standin.origin,
//   });
//   standin.setNext(["ratelimit"]); // queue one scenario per decision request
//   ... ask ...
//   standin.requests(); // recorded { method, path, headers, bodyText, body }
//
// Or run standalone: `node tools/fixtures/decisions/standin.mjs [port]`.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DEFAULT_TOKENS = {
  jev: "test-typesafe-key",
  cf: "test-cf-token",
  accountId: "test-cf-account",
};

/**
 * @typedef {string | { scenario: string, retryAfter?: string, delayMs?: number }} ScenarioEntry
 * @typedef {{ method: string, path: string, headers: Record<string, string | undefined>, bodyText: string, body: unknown }} RecordedRequest
 * @typedef {{ tokens?: { jev?: string, cf?: string, accountId?: string } }} StandinOptions
 */

/** Read the request body as text, capped to avoid abuse. */
function readBodyText(req, capBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Synthesize a successful answer from the request's q0 question. */
function autoAnswer(body) {
  const q0 = body?.questions?.q0;
  const model = typeof body?.model === "string" ? body.model : "unknown";
  const usage = { input_tokens: 12, output_tokens: 5 };
  if (!q0 || typeof q0 !== "object") {
    return { status: 400, payload: { error: { message: "missing q0 question" } } };
  }
  if (q0.type === "noul") {
    return { status: 200, payload: { model, answers: { q0: { type: "noul", noul: 0.75 } }, usage } };
  }
  if (q0.type === "choice") {
    const options = Object.keys(q0.criteria ?? {});
    const choice = options[0] ?? "a";
    const probabilities = {};
    for (const [i, option] of options.entries()) {
      probabilities[option] = i === 0 ? 0.7 : 0.3 / Math.max(1, options.length - 1);
    }
    return {
      status: 200,
      payload: { model, answers: { q0: { type: "choice", choice, probabilities } }, usage },
    };
  }
  if (q0.type === "score") {
    const criteria = Array.isArray(q0.criteria) ? q0.criteria : [];
    const mid = Math.floor(criteria.length / 2);
    const probabilities = {};
    criteria.forEach((_, i) => {
      probabilities[String(i)] = i === mid ? 0.6 : 0.4 / Math.max(1, criteria.length - 1);
    });
    return {
      status: 200,
      payload: {
        model,
        answers: { q0: { type: "score", score: mid + 0.2, probabilities } },
        usage,
      },
    };
  }
  return { status: 400, payload: { error: { message: `unknown question type ${String(q0.type)}` } } };
}

function wrapForCf(payload) {
  return { result: payload, success: true, errors: [], messages: [] };
}

/**
 * Start the stand-in on a loopback address with an ephemeral port.
 * @param {StandinOptions} [options]
 */
export async function startStandin(options = {}) {
  const tokens = { ...DEFAULT_TOKENS, ...(options.tokens ?? {}) };
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {ScenarioEntry[]} */
  const queue = [];
  let active = 0;
  let peak = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/__requests" && req.method === "GET") {
      sendJson(res, 200, { requests });
      return;
    }
    if (url.pathname === "/__control" && req.method === "POST") {
      const text = await readBodyText(req).catch(() => "");
      try {
        const control = JSON.parse(text);
        if (Array.isArray(control.next)) {
          queue.length = 0;
          queue.push(...control.next);
        }
        sendJson(res, 200, { queued: queue.length });
      } catch {
        sendJson(res, 400, { error: { message: "invalid control body" } });
      }
      return;
    }
    if (url.pathname === "/__reset" && req.method === "POST") {
      requests.length = 0;
      queue.length = 0;
      peak = 0;
      sendJson(res, 200, { reset: true });
      return;
    }

    active += 1;
    peak = Math.max(peak, active);
    // The client may abort (e.g. timeout tests); never throw on a dead socket.
    const alive = () => !res.destroyed && !res.writableEnded;
    const send = (status, payload, extra) => {
      if (alive()) {
        try {
          sendJson(res, status, payload, extra);
        } catch {
          // Client went away mid-write; nothing to do.
        }
      }
    };
    try {
      const bodyText = await readBodyText(req).catch(() => "");
      let body = null;
      try {
        body = bodyText === "" ? null : JSON.parse(bodyText);
      } catch {
        body = null;
      }

      const isJev = url.pathname === "/v1/systemone";
      const cfMatch = url.pathname.match(
        /^\/client\/v4\/accounts\/([^/]+)\/ai\/run\/@cf\/cloudflare\/(clef|clef-flash)$/,
      );
      if (!isJev && !cfMatch) {
        send(404, { error: { message: "unknown stand-in route" } });
        return;
      }
      if (cfMatch && cfMatch[1] !== tokens.accountId) {
        send(404, { error: { message: "unknown account" } });
        return;
      }
      const expected = isJev ? `Bearer ${tokens.jev}` : `Bearer ${tokens.cf}`;

      const headers = {
        authorization: req.headers.authorization,
        "content-type": req.headers["content-type"],
        accept: req.headers.accept,
      };
      requests.push({ method: req.method ?? "", path: url.pathname, headers, bodyText, body });

      if (req.headers.authorization !== expected) {
        send(401, { error: { message: "unauthorized" } });
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: { message: "method not allowed" } });
        return;
      }

      const entry = queue.length > 0 ? queue.shift() : "auto";
      const scenario = typeof entry === "string" ? entry : entry.scenario;
      const params = typeof entry === "string" ? {} : entry;

      const respondAuto = (forceWrap) => {
        const built = autoAnswer(body);
        if (built.status !== 200) {
          send(built.status, built.payload);
          return;
        }
        const wrap = forceWrap ?? !isJev;
        send(200, wrap ? wrapForCf(built.payload) : built.payload);
      };

      switch (scenario) {
        case "auto":
          respondAuto();
          break;
        case "bare":
          respondAuto(false);
          break;
        case "wrapped":
          respondAuto(true);
          break;
        case "refusal-missing":
          send(200, isJev ? bare() : wrapForCf(bare()));
          break;
        case "refusal-wrongtype":
          send(200, isJev ? wrongType() : wrapForCf(wrongType()));
          break;
        case "malformed":
          if (alive()) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("not-json{{{");
          }
          break;
        case "oversized": {
          const pad = "x".repeat(1024 * 1024 + 64);
          const payload = { model: "m", answers: { q0: { type: "noul", noul: 0.5 } }, pad };
          send(200, isJev ? payload : wrapForCf(payload));
          break;
        }
        case "slow":
          await new Promise((resolve) => setTimeout(resolve, params.delayMs ?? 300));
          respondAuto();
          break;
        case "ratelimit":
          send(429, { error: { message: "rate limited" } }, { "retry-after": params.retryAfter ?? "0" });
          break;
        case "error-500":
          send(500, { error: { message: "boom" } });
          break;
        case "error-400":
          send(400, { error: { message: "bad model 'zzz'" } });
          break;
        case "echo-key":
          send(400, {
            error: { message: `unknown key ${String(req.headers.authorization ?? "")}` },
          });
          break;
        case "redirect":
          if (alive()) {
            res.writeHead(302, { location: "/elsewhere" });
            res.end();
          }
          break;
        default:
          send(400, { error: { message: `unknown stand-in scenario ${scenario}` } });
          break;
      }

      function bare() {
        return { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      function wrongType() {
        const q0 = body?.questions?.q0;
        const other =
          q0?.type === "noul"
            ? { type: "choice", choice: "a" }
            : { type: "noul", noul: 0.5 };
        return { model: "m", answers: { q0: other }, usage: { input_tokens: 1, output_tokens: 1 } };
      }
    } finally {
      active -= 1;
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("stand-in failed to bind");
  }

  const handle = {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests: () => [...requests],
    lastRequest: () => requests[requests.length - 1],
    setNext: (next) => {
      queue.length = 0;
      queue.push(...next);
    },
    clear: () => {
      requests.length = 0;
      queue.length = 0;
      peak = 0;
    },
    maxActive: () => peak,
    resetPeak: () => {
      peak = 0;
    },
    /** Wait until no request handler is still running (e.g. abandoned slow responses). */
    drain: async (timeoutMs = 5000) => {
      const start = Date.now();
      while (active > 0) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("stand-in did not drain");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  return handle;
}

const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const standin = await startStandin();
  console.log(`decision stand-in listening at ${standin.origin}`);
}
