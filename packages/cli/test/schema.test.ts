import { specJsonSchema } from "@tsv/spec";
import { expect, it } from "vitest";
import { tsv } from "./run";

it("schema prints the spec JSON Schema as JSON", async () => {
  const r = await tsv(["schema"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual(specJsonSchema());
});
