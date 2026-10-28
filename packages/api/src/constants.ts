/** Wire contract constants shared by the browser client and the server. */
export const API_MAJOR = 1 as const;
export const API_BASE_PATH = "/api";
export const API_MAJOR_HEADER = "X-DevChestra-Api";
export const CSRF_HEADER = "X-DevChestra-Csrf";
export const CSRF_VALUE = "1";
export const TOKEN_HEADER = "X-DevChestra-Token";
export const SESSION_COOKIE = "devchestra_session";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const ETAG_HEADER = "ETag";
export const IF_MATCH_HEADER = "If-Match";
export const REQUEST_ID_HEADER = "X-Request-Id";
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_TRANSCRIPT_LIMIT = 200;
