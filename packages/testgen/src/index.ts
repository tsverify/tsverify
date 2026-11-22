// @tsv/testgen: generated vitest files (doc 6 §3.7). Depends only on @tsv/ir; the generated code
// imports @tsv/runtime at test time. Pure: no filesystem, deterministic output.
import { buildContext } from "./context";
import { forbiddenFile } from "./forbidden";
import { guardsFile } from "./guards";
import { pathsFile } from "./paths";
import type { GeneratedFile, GeneratedTest, GenerateInput, GenerateResult } from "./types";

export type {
  GeneratedFile,
  GeneratedTest,
  GeneratedTestKind,
  GenerateInput,
  GenerateResult,
} from "./types";

/**
 * The test files for one spec and its code model:
 *
 * - `paths.test.ts`: each drivable transition from each allowed state reaches `to`, calls its
 *   declared effects (exactly-once: once) and no other effect
 * - `forbidden.test.ts`: from every other state, the state is unchanged and no declared effect fires
 * - `guards.test.ts`: as an actor (with a fixture) not in `by`, the state is unchanged
 *
 * Whatever cannot be generated (no fixtures, no invocation shape, non-`assign` persistence, …)
 * is explained by an `info` finding in `skipped`. Throws only for programmer errors (models with
 * the wrong origin).
 */
export function generate(input: GenerateInput): GenerateResult {
  const { ctx, skipped } = buildContext(input);
  if (ctx === undefined) return { files: [], skipped, tests: [] };
  const files: GeneratedFile[] = [];
  const tests: GeneratedTest[] = [];
  const add = (out: { file?: GeneratedFile; tests: GeneratedTest[] } | undefined) => {
    if (out?.file) files.push(out.file);
    if (out) tests.push(...out.tests);
  };
  add(pathsFile(ctx));
  add(forbiddenFile(ctx));
  const guards = guardsFile(ctx);
  add(guards);
  skipped.push(...guards.skipped);
  return { files, skipped, tests };
}
