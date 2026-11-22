import { describe, expect, it } from "vitest";
import { specJsonSchema } from "./json-schema";

// The full schema is checked in as packages/spec/behavior.schema.json (drift test:
// test/schema-file.test.ts).
describe("specJsonSchema", () => {
  it("is strict about unknown keys and lists the required top-level keys", () => {
    const schema = specJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["behavior", "entity", "actors", "transitions"]);
  });
});
