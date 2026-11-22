// @tsv/testgen: generated vitest files (doc 6 §3.7). Depends only on @tsv/ir; the generated code
// imports @tsv/runtime at test time. Pure: no filesystem, deterministic output.
import { buildContext } from "./context";
import type { GenerateInput, GenerateResult } from "./types";

export type {
  GeneratedFile,
  GeneratedTest,
  GeneratedTestKind,
  GenerateInput,
  GenerateResult,
} from "./types";

/**
 * The test files for one spec and its code model. Whatever cannot be generated (no fixtures,
 * no invocation shape, non-`assign` persistence, …) is explained by an `info` finding in
 * `skipped`. Throws only for programmer errors (models with the wrong origin).
 */
export function generate(input: GenerateInput): GenerateResult {
  const { skipped } = buildContext(input);
  return { files: [], skipped, tests: [] };
}
