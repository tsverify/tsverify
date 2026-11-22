/**
 * Replay tests (`replay-<n>.test.ts` + `replay-<n>.json`): one per finding with a counterexample,
 * from the spec model or the code model. The test forces the real code through the trace's
 * interleaving with `@tsv/runtime` (shape: packages/runtime/test/generated-shape.test.ts):
 * fakes, `vi.mock` of the client modules, dynamic impl imports, `planFromTrace` on the JSON
 * sidecar (trace + the code model's `CodeSites` subset), seed, one worker per trace worker,
 * `tryPlay`, `drain`, then the violated property in code terms and `replayResult`.
 *
 * The verdict goes to `task.meta.tsvReplay` (read back by `tsv test`). A `confirmed` or
 * `confirmed-divergent` verdict fails the test. When the property is not an effect count or a
 * status check, the test calls `replayResult(outcome, undefined)`: verdict `inconclusive`, passes.
 */
import type { Finding } from "@tsv/ir";
import { type Context, effectGate } from "./context";
import { headerText, member, propertyKey } from "./emit";
import { ENTITY, prelude, SCHEDULER } from "./prelude";
import { evaluation } from "./property";
import { gateMapping, planReplay, type ReplayPlanView } from "./replay-plan";
import { skipFinding } from "./skips";
import type { GeneratedFile, GeneratedTest } from "./types";

const RUNTIME = ["mappingFromCode", "planFromTrace", "type ReplayResult", "replayResult"];
const HELPERS = ["INVOKE", "PROPERTY", "plan", "sidecar", "stored", "observedEffects"];

export function replayFiles(
  ctx: Context,
  findings: readonly Finding[],
): { files: GeneratedFile[]; tests: GeneratedTest[]; skipped: Finding[] } {
  const files: GeneratedFile[] = [];
  const tests: GeneratedTest[] = [];
  const skipped: Finding[] = [];
  const gates = gateMapping(ctx.code);
  let n = 0;
  for (const finding of findings) {
    const trace = finding.trace;
    if (trace === undefined) continue;
    const planned = planReplay(trace, gates, (t) => ctx.linked.has(t));
    if (!planned.ok) {
      skipped.push(
        skipFinding(
          ctx.behavior,
          `replay:${finding.id}`,
          `tsv test generated no replay for ${finding.id}: ${planned.reason}`,
          {
            ...(finding.transition === undefined ? {} : { transition: finding.transition }),
            ...(finding.specAt ? { specAt: finding.specAt } : {}),
          },
        ),
      );
      continue;
    }
    n++;
    const out = replayFile(ctx, finding, planned.plan, n);
    files.push(...out.files);
    tests.push(out.test);
  }
  return { files, tests, skipped };
}

function replayFile(
  ctx: Context,
  finding: Finding,
  plan: ReplayPlanView,
  n: number,
): { files: GeneratedFile[]; test: GeneratedTest } {
  const trace = plan.trace;
  const file = `replay-${n}.test.ts`;
  const sidecarFile = `replay-${n}.json`;
  const evaluated = evaluation({
    finding,
    rules: ctx.spec.rules,
    gate: (effect) => effectGate(ctx, effect),
    exactlyOnce: [
      ...new Set(
        ctx.spec.transitions.flatMap((t) =>
          t.effects.filter((e) => e.multiplicity === "exactly-once").map((e) => e.name),
        ),
      ),
    ],
  });
  const header = {
    specFile: ctx.specFile,
    behavior: ctx.behavior,
    source: [
      `finding ${finding.id}`,
      ...finding.message.split("\n").map((l) => l.trim()),
      `Replays its ${trace.model}-model counterexample against the real code (sidecar: ${sidecarFile}).`,
    ],
  };
  const transitions = [...new Set(plan.workers.map((w) => w.transition))].sort();
  const linked = transitions.map((t) => {
    const l = ctx.linked.get(t);
    if (l === undefined) throw new Error(`testgen: replay worker transition ${t} is not drivable`);
    return l;
  });

  const p = prelude(ctx, {
    header,
    runtime: RUNTIME,
    imports: [`import sidecar from "./${sidecarFile}" with { type: "json" };`],
    declarations: [
      `declare module "vitest" {`,
      "  interface TaskMeta {",
      "    /** Read back by `tsv test`: the verdict, plus the stored status and effect counts it saw. */",
      "    tsvReplay?: ReplayResult & {",
      "      status: unknown;",
      "      effects: Record<string, number>;",
      "    };",
      "  }",
      "}",
    ],
    impls: linked.map((l) => l.invocation.impl),
    reserved: HELPERS,
  });

  const field = ctx.spec.entity.stateField;
  const optional = member(field).startsWith(".") ? `?${member(field)}` : `?.${member(field)}`;
  const { storage } = ctx;
  const lines = [...p.lines, ""];
  lines.push("/** One invocation per transition the counterexample's workers perform. */");
  lines.push("const INVOKE: Record<string, () => Promise<unknown>> = {");
  for (const l of linked) {
    const impl = p.impls.get(`${l.invocation.impl.file}#${l.invocation.impl.symbol}`) ?? "";
    const who = l.actor === undefined ? "no actor argument" : `as ${l.actor}`;
    lines.push(`  ${propertyKey(l.spec.name)}: () => ${impl}(${l.args}), // ${who}`);
  }
  lines.push("};", "");

  lines.push(
    `const plan = planFromTrace(sidecar.trace, mappingFromCode(sidecar.code)${plan.replayFrom === undefined ? "" : `, { replayFrom: ${plan.replayFrom} }`});`,
  );
  lines.push(...scheduleComment(ctx, plan));
  lines.push("");
  lines.push(`const PROPERTY = ${JSON.stringify(evaluated.description)};`, "");
  lines.push(
    `/** The entity's ${field} as stored now. */`,
    "function stored(): unknown {",
    `  return ${p.store}.read(${JSON.stringify(storage.collection)}, ID)${optional};`,
    "}",
    "",
    "/** Effect calls by gate: the fast-forwarded prefix's counts plus the calls in this run. */",
    "function observedEffects(): Record<string, number> {",
    "  const counts: Record<string, number> = { ...plan.seedEffects };",
    `  for (const call of ${SCHEDULER}.effects()) counts[call.effect] = (counts[call.effect] ?? 0) + 1;`,
    "  return counts;",
    "}",
    "",
  );

  const name = `replay: ${evaluated.label} (${plan.workers.map((w) => w.id).join(" ∥ ")})`;
  lines.push(`test(${JSON.stringify(name)}, async ({ task }) => {`);
  lines.push(`  ${SCHEDULER}.reset();`);
  lines.push(
    `  ${p.store}.seed({ ${propertyKey(storage.collection)}: [{ ...${ENTITY}, ${propertyKey(field)}: plan.seedStatus }] });`,
  );
  lines.push("  for (const w of plan.workers) {");
  lines.push("    const call = INVOKE[w.transition];");
  lines.push(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted code contains a template literal
    "    if (call === undefined) throw new Error(`no invocation for ${w.transition}`);",
  );
  lines.push(`    ${SCHEDULER}.spawn(w.id, call);`);
  lines.push("  }");
  lines.push(`  const outcome = await ${SCHEDULER}.tryPlay(plan.schedule);`);
  lines.push(`  await ${SCHEDULER}.drain();`);
  lines.push("  const status = stored();");
  lines.push("  const effects = observedEffects();");
  if (evaluated.evaluable) {
    lines.push(`  // ${evaluated.description}`);
    lines.push(`  const violated = ${evaluated.violated};`);
    lines.push("  const result = replayResult(outcome, violated);");
    lines.push("  task.meta.tsvReplay = { ...result, status, effects };");
    lines.push(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted code contains a template literal
      '  const why = `${result.verdict}: the real code violates ${PROPERTY}\\n${result.divergence?.message ?? ""}`;',
    );
    lines.push("  expect(result.violated, why.trim()).toBe(false);");
  } else {
    lines.push(`  // Inconclusive: ${evaluated.reason}.`);
    lines.push("  task.meta.tsvReplay = { ...replayResult(outcome, undefined), status, effects };");
  }
  lines.push("});");

  const sidecar = {
    $comment: headerText(header),
    trace,
    code: codeSubset(ctx),
  };
  const test: GeneratedTest = {
    file,
    name,
    kind: "replay",
    finding: finding.id,
    property: trace.property,
    model: trace.model,
    evaluable: evaluated.evaluable,
  };
  if (finding.transition !== undefined) test.transition = finding.transition;
  if (finding.specAt) test.specAt = finding.specAt;
  if (finding.codeAt) test.codeAt = finding.codeAt;
  return {
    files: [
      { path: file, content: `${lines.join("\n")}\n` },
      { path: sidecarFile, content: `${JSON.stringify(sidecar, null, 2)}\n` },
    ],
    test,
  };
}

/** The plan as comments: fast-forwarded steps, then each replayed step and its gates. */
function scheduleComment(ctx: Context, plan: ReplayPlanView): string[] {
  const out: string[] = [];
  const steps = (list: typeof plan.skipped) =>
    list.map((s) => (s.action ? `${s.action.worker} ${s.action.kind}` : "")).join(", ");
  if (plan.skipped.length > 0) {
    const first = plan.skipped[0]?.index;
    const last = plan.skipped.at(-1)?.index;
    const range = first === last ? `step ${first}` : `steps ${first}-${last}`;
    out.push(
      `// ${range} (${steps(plan.skipped)}) fast-forwarded: seed ${ctx.spec.entity.stateField} ${JSON.stringify(plan.seed.status)}`,
    );
  } else {
    out.push(
      `// nothing fast-forwarded: the replay starts from ${ctx.spec.entity.stateField} ${JSON.stringify(plan.seed.status)}`,
    );
  }
  const rows = plan.replayed.flatMap((s) => {
    const a = s.action;
    if (!a) return [];
    const gates = plan.schedule
      .filter((g) => g.step === s.index && g.worker === a.worker)
      .map((g) => `[${a.worker}, ${g.gate}]`);
    const dup = a.duplicate ? " (duplicate delivery)" : "";
    return [{ left: `step ${s.index}  ${a.worker} ${a.kind}${dup}`, right: gates.join(" ") }];
  });
  const width = Math.max(0, ...rows.map((r) => r.left.length));
  for (const r of rows) out.push(`// ${r.left.padEnd(width)}  → ${r.right || "(no gate)"}`);
  out.push(`// then each worker runs until done: ${plan.workers.map((w) => w.id).join(", ")}`);
  return out;
}

/** The `CodeSites` subset `mappingFromCode` reads, without source locations. */
function codeSubset(ctx: Context): unknown {
  return {
    transitions: ctx.code.transitions.flatMap((t) => {
      const s = t.sites;
      if (!s) return [];
      const sites: Record<string, unknown> = {};
      if (s.specTransition !== undefined) sites.specTransition = s.specTransition;
      if (s.read) sites.read = withoutAt(s.read);
      if (s.commit) sites.commit = withoutAt(s.commit);
      if (s.atomic) sites.atomic = withoutAt(s.atomic);
      sites.effects = s.effects.map(withoutAt);
      return [{ name: t.name, sites }];
    }),
    bindings: { effects: ctx.code.bindings.effects },
  };
}

function withoutAt<T extends { at?: unknown }>(value: T): Omit<T, "at"> {
  const { at: _, ...rest } = value;
  return rest;
}
