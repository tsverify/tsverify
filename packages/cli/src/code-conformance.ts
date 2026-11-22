import { posix, resolve } from "node:path";
import { type CheckStats, check } from "@tsverify/checker";
import { compare } from "@tsverify/conformance";
import { type ExtractStats, extractAll } from "@tsverify/extractor";
import type { BehaviorModel, Finding } from "@tsverify/ir";
import type { LoadedSpec } from "./inputs";
import { rebaseFile, rebaseLocations } from "./locations";
import { findProjectRoot, TSCONFIG } from "./project-root";
import { linkRootCauses } from "./root-causes";

export interface CodeConformanceOptions {
  /** Absolute; spec files are relative to it, and so are the returned locations. */
  cwd: string;
  /** Absolute `--project` directory, used for every spec instead of discovery. */
  project?: string;
  maxStates?: number;
}

/** Steps 3–5 of `tsv check` for one spec. */
export interface CodeOutcome {
  /** Project root relative to the cwd (`.` for the cwd); `null` when none was found. */
  project: string | null;
  /**
   * Extractor findings, conformance mismatches, then code-model checker findings, with
   * `causedBy` linking the latter to the mismatches that explain them (`root-causes.ts`).
   */
  findings: Finding[];
  /** Present when the extractor ran for the spec's project. */
  extract?: ExtractStats;
  /** Present when the extractor returned a code model and it was model-checked. */
  codeStats?: CheckStats;
  /** Absolute project root; present when one was found. */
  root?: string;
  /**
   * The spec model as the extractor saw it (locations relative to `root`). Present when the spec
   * is valid and its project was extracted. `tsv test` generates tests from it and `code`.
   */
  spec?: BehaviorModel;
  /** The as-implemented model (locations relative to `root`), when the extractor built one. */
  code?: BehaviorModel;
}

/**
 * Code conformance for every spec, aligned with `specs`: extract the as-implemented model
 * (`@tsverify/extractor`, one `extractAll` per project root), compare it with the spec
 * (`@tsverify/conformance`), model-check it (`@tsverify/checker`), and link the checker's findings to the
 * mismatches behind them (`linkRootCauses`). Specs without a model (invalid
 * input) get no findings here. A spec with no `tsconfig.json` at or above it gets one
 * `broken-link` finding.
 *
 * The extractor and conformance work with project-root-relative paths, so each spec model is
 * rebased onto its project root before extraction and every finding is rebased back onto the
 * cwd afterwards, which keeps all locations consistent (spec ones included).
 */
export async function checkCode(
  specs: readonly LoadedSpec[],
  options: CodeConformanceOptions,
): Promise<CodeOutcome[]> {
  const { cwd, maxStates } = options;
  const roots = await Promise.all(
    specs.map((s) => options.project ?? findProjectRoot(resolve(cwd, s.file))),
  );
  const outcomes: CodeOutcome[] = roots.map((root) => ({
    project: root === undefined ? null : rebaseFile(root, cwd, cwd),
    findings: [],
    ...(root === undefined ? {} : { root }),
  }));

  const projects = new Map<string, { index: number; model: BehaviorModel }[]>();
  specs.forEach((spec, index) => {
    const root = roots[index];
    if (spec.model === undefined) return;
    if (root === undefined) {
      (outcomes[index] as CodeOutcome).findings.push(noProject(spec.file, spec.model));
      return;
    }
    const members = projects.get(root) ?? [];
    members.push({ index, model: spec.model });
    projects.set(root, members);
  });

  for (const [root, members] of projects) {
    const models = members.map((m) => rebaseLocations(m.model, cwd, root));
    const { results, stats } = extractAll(models, { projectRoot: root });
    members.forEach(({ index }, k) => {
      const spec = models[k] as BehaviorModel;
      const result = results[k];
      if (result === undefined) throw new Error(`extractAll returned no result for ${spec.name}`);
      const outcome = outcomes[index] as CodeOutcome;
      const findings = [...result.findings];
      outcome.extract = stats;
      outcome.spec = spec;
      if (result.model) {
        outcome.code = result.model;
        findings.push(...compare(spec, result.model));
        const checked = check(result.model, { maxStates });
        findings.push(...checked.findings.map((f) => withSpecAt(f, spec)));
        outcome.codeStats = checked.stats;
      }
      outcome.findings = rebaseLocations(linkRootCauses(findings, spec), root, cwd);
    });
  }
  return outcomes;
}

/**
 * Code-model checker findings carry code locations only (the checker never sees the spec). The
 * CLI holds both models, so it points `specAt` at the spec transition the finding is about.
 */
function withSpecAt(finding: Finding, spec: BehaviorModel): Finding {
  if (finding.specAt !== undefined || finding.transition === undefined) return finding;
  const at = spec.transitions.find((t) => t.name === finding.transition)?.at;
  return at === undefined ? finding : { ...finding, specAt: at };
}

function noProject(file: string, model: BehaviorModel): Finding {
  const dir = posix.dirname(file);
  return {
    id: `broken-link:${model.name}:tsconfig`,
    category: "broken-link",
    severity: "error",
    message: `no ${TSCONFIG} in ${dir === "." ? "the current directory" : dir} or any directory above it, so the code behind \`impl\` and \`bindings\` can't be located`,
    behavior: model.name,
    specAt: { file, line: 1, column: 1 },
    hint: "Pass --project <dir> to name the TypeScript project root, or --spec-only to check the spec alone.",
  };
}
