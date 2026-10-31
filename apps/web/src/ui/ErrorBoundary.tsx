import { Component, type ReactNode } from "react";

/**
 * Contains a render failure to one subtree. The fallback replaces only that
 * subtree, so one unrenderable value cannot blank the page around it.
 */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("A value could not be rendered.", error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
