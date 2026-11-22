import { specJsonSchema } from "@tsverify/spec";
import { expect, it } from "vitest";
import { tsverify } from "./run";

it("schema prints the spec JSON Schema as JSON", async () => {
  const r = await tsverify(["schema"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual(specJsonSchema());
});
