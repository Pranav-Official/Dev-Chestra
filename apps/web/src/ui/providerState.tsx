import { createContext, useContext } from "react";

export interface ProviderState {
  /** True when the provider (CLI id) is turned off in Settings. */
  isDisabled(cli: string): boolean;
}

const ALL_ENABLED: ProviderState = { isDisabled: () => false };

const ProviderStateContext = createContext<ProviderState>(ALL_ENABLED);

/**
 * Optional context. The editor provides it from the provider list; canvas nodes read it to
 * dim a turned-off provider. Without a provider every CLI counts as enabled, so canvas
 * components keep rendering in tests that mount no providers (no QueryClientProvider needed).
 */
export const ProviderStateProvider = ProviderStateContext.Provider;

export function useProviderState(): ProviderState {
  return useContext(ProviderStateContext);
}
