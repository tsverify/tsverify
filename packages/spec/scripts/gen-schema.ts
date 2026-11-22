/**
 * Writes `behavior.schema.json` (the JSON Schema of `*.behavior.yaml`) from `specJsonSchema()`.
 * Run with `pnpm --filter @tsv/spec gen:schema`, which also formats the file with Biome.
 * `test/schema-file.test.ts` fails when the checked-in file is stale.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { specJsonSchema } from "../src/json-schema";

const out = fileURLToPath(new URL("../behavior.schema.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(specJsonSchema(), null, 2)}\n`);
