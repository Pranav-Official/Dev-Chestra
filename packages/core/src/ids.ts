import { type Clock, systemClock } from "./clock.js";
import { RelayError } from "./error.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, "RunId">;
export type ProjectId = Brand<string, "ProjectId">;
export type WorkflowId = Brand<string, "WorkflowId">;
export type NodeId = Brand<string, "NodeId">;
export type EntryId = Brand<string, "EntryId">;

export interface IdGen {
  runId(): RunId;
  entryId(): EntryId;
  token(): string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function cryptoApi(): Crypto {
  const api = globalThis.crypto;
  if (api === undefined || typeof api.getRandomValues !== "function") {
    throw new RelayError("E_INTERNAL", "Secure randomness is unavailable in this runtime");
  }
  return api;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

function encodeTime(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RelayError("E_VALIDATION", `Cannot encode ULID time ${String(now)}`);
  }
  let time = now;
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function ulid(clock: Clock): string {
  return encodeTime(clock.now()) + encodeBase32(randomBytes(10)).slice(0, 16);
}

export function createSystemIds(clock: Clock = systemClock): IdGen {
  return {
    runId: () => ulid(clock) as RunId,
    entryId: () => ulid(clock) as EntryId,
    token: () => base64url(randomBytes(32)),
  };
}

export const systemIds: IdGen = createSystemIds();

export class FakeIdGen implements IdGen {
  private runCounter = 0;
  private entryCounter = 0;
  private tokenCounter = 0;

  constructor(private readonly prefix = "fake") {}

  runId(): RunId {
    this.runCounter += 1;
    return `${this.prefix}-run-${this.runCounter}` as RunId;
  }

  entryId(): EntryId {
    this.entryCounter += 1;
    return `${this.prefix}-entry-${this.entryCounter}` as EntryId;
  }

  token(): string {
    this.tokenCounter += 1;
    return `${this.prefix}-token-${this.tokenCounter}`;
  }
}

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

export function parseRunId(value: string): Result<RunId, RelayError> {
  if (!isUlid(value)) {
    return err(new RelayError("E_VALIDATION", `Invalid run id: ${value}`));
  }
  return ok(value as RunId);
}

export function parseEntryId(value: string): Result<EntryId, RelayError> {
  if (!isUlid(value)) {
    return err(new RelayError("E_VALIDATION", `Invalid entry id: ${value}`));
  }
  return ok(value as EntryId);
}
