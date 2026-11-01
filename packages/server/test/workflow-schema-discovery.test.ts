import { parseWorkflow, validateWorkflow, workflowJsonSchema } from "@devchestra/schema";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

describe("workflow schema discovery", () => {
  it("exposes structural rules while leaving graph semantics to the validator", () => {
    const validate = new Ajv2020({ strict: false }).compile(workflowJsonSchema());
    const empty = { schemaVersion: 1, id: "empty", name: "Empty", graph: { nodes: [], edges: [] } };
    expect(validate(empty)).toBe(true);
    const parsed = parseWorkflow(empty);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    expect(validateWorkflow(parsed.value).ok).toBe(false);
    const unknown = { ...empty, unexpected: true };
    expect(validate(unknown)).toBe(false);
    expect(parseWorkflow(unknown).ok).toBe(false);
    const wrongNode = {
      ...empty,
      graph: { nodes: [{ id: "a", name: "A", type: "invented" }], edges: [] },
    };
    expect(validate(wrongNode)).toBe(false);
    expect(parseWorkflow(wrongNode).ok).toBe(false);
  });
});
