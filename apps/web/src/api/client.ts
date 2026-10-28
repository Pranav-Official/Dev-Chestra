import {
  ApiClient,
  ApiError,
  ApiProtocolError,
  ApiTransportError,
  isApiError,
} from "@devchestra/api";

export const api = new ApiClient({ baseUrl: "" });

export type ApiFailure = {
  kind: "auth" | "notfound" | "network" | "protocol" | "server";
  message: string;
  code: string | null;
};

export function classifyError(error: unknown): ApiFailure {
  if (isApiError(error)) {
    if (error.code === "E_AUTH" || error.status === 401) {
      return { kind: "auth", message: error.message, code: error.code };
    }
    if (error.code === "E_NOT_FOUND" || error.status === 404) {
      return { kind: "notfound", message: error.message, code: error.code };
    }
    return { kind: "server", message: error.message, code: error.code };
  }
  if (error instanceof ApiTransportError) {
    return { kind: "network", message: error.message, code: null };
  }
  if (error instanceof ApiProtocolError) {
    return { kind: "protocol", message: error.message, code: null };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "network", message: error.message, code: null };
  }
  return {
    kind: "network",
    message: error instanceof Error ? error.message : "The request failed.",
    code: null,
  };
}

export { ApiError, ApiProtocolError, ApiTransportError, isApiError };
