import type { Store } from "@relay/store";
import { createStoreStreamPort, createStreamHub, mountStreamRoutes } from "../stream/index.js";
import type { BrowserStreamPort } from "./ports.js";

export function createBrowserStream(store: Store): BrowserStreamPort {
  const hub = createStreamHub({ store: createStoreStreamPort(store) });
  return {
    mountRoutes: (app) => {
      mountStreamRoutes(app, hub);
    },
    close: () => {
      hub.close();
    },
  };
}
