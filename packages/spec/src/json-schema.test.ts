import { describe, expect, it } from "vitest";
import { specJsonSchema } from "./json-schema";

describe("specJsonSchema", () => {
  it("matches the golden schema", async () => {
    await expect(`${JSON.stringify(specJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(
      "../test/__golden__/spec.schema.json",
    );
  });

  it("is strict about unknown keys and lists the required top-level keys", () => {
    const schema = specJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["behavior", "entity", "actors", "transitions"]);
  });
});
