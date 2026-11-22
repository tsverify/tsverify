import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { specJsonSchema } from "../src/index";

const FILE = fileURLToPath(new URL("../behavior.schema.json", import.meta.url));
const REGEN = "pnpm --filter @tsv/spec gen:schema";

describe("packages/spec/behavior.schema.json", () => {
  it("is up to date with specJsonSchema()", () => {
    const checkedIn: unknown = JSON.parse(readFileSync(FILE, "utf8"));
    expect(
      checkedIn,
      `packages/spec/behavior.schema.json is stale (the zod schema changed). Regenerate it with \`${REGEN}\` and commit the result.`,
    ).toEqual(specJsonSchema());
  });

  it("is exported as @tsv/spec/behavior.schema.json", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@tsv/spec/behavior.schema.json")).toBe(FILE);
  });
});
