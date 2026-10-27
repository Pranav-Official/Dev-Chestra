import { QueryClient } from "@tanstack/react-query";
import { classifyError } from "./client.js";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          const failure = classifyError(error);
          if (failure.kind === "auth" || failure.kind === "notfound") return false;
          return failureCount < 2;
        },
      },
    },
  });
}
