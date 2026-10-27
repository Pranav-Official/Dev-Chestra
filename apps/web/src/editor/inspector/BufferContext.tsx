import { createContext, useContext, useEffect } from "react";

export interface BufferRegistry {
  readonly session: string;
  setInvalid: (fieldKey: string, reason: string | null) => void;
}

export const BufferContext = createContext<BufferRegistry | null>(null);

/**
 * Publish a local form-buffer problem (invalid JSON, a partial number, an
 * uncommittable default) for one field. Cleared automatically on unmount.
 */
export function useBufferFlag(fieldKey: string, reason: string | null): void {
  const registry = useContext(BufferContext);
  useEffect(() => {
    if (registry === null) return;
    registry.setInvalid(fieldKey, reason);
    return () => registry.setInvalid(fieldKey, null);
  }, [registry, fieldKey, reason]);
}
