// biome-ignore-all lint/a11y/noNoninteractiveTabindex: scrollable output must be keyboard reachable
import { jsonText } from "./format.js";

export function JsonView({ value, testId }: { value: unknown; testId?: string }) {
  return (
    <pre className="code" data-testid={testId} tabIndex={0}>
      {jsonText(value)}
    </pre>
  );
}
