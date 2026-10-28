import { type ValidationReport, validateWorkflow, type WorkflowFile } from "@devchestra/schema";
import { useEffect, useRef, useState } from "react";
import { createValidationClient, type ValidationClient } from "../model/validation.js";

export interface EditorValidation {
  report: ValidationReport | null;
  /** Revision the visible report was produced for. */
  revision: number;
  current: boolean;
}

function workerAvailable(): boolean {
  return typeof globalThis.Worker === "function";
}

export function useEditorValidation(file: WorkflowFile, revision: number): EditorValidation {
  const [state, setState] = useState<{ report: ValidationReport | null; revision: number }>({
    report: null,
    revision: -1,
  });
  const clientRef = useRef<ValidationClient | null>(null);

  useEffect(() => {
    if (!workerAvailable()) return;
    const client = createValidationClient({
      onResult: (report, resultRevision) => {
        setState((previous) =>
          resultRevision >= previous.revision ? { report, revision: resultRevision } : previous,
        );
      },
    });
    clientRef.current = client;
    return () => {
      clientRef.current = null;
      client.dispose();
    };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (client !== null) {
      client.validate(file, revision);
      return;
    }
    if (workerAvailable()) return;
    // jsdom/no-Worker fallback only; the browser path never validates on the main thread.
    const report = validateWorkflow(file);
    setState((previous) => (revision >= previous.revision ? { report, revision } : previous));
  }, [file, revision]);

  return {
    report: state.report,
    revision: state.revision,
    current: state.report !== null && state.revision === revision,
  };
}
