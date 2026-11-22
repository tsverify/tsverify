/**
 * Assembly of the three state-driving test files (paths, forbidden, guards): prelude, the
 * `seed` / `stored` / `calls` helpers, then one `test(…)` per case. Each case seeds the entity
 * in a state, calls the real impl once (outside any scheduler worker, so every gate passes
 * straight through) and asserts on the stored state and the recorded effect calls.
 */
import type { SourceLocation } from "@tsv/ir";
import type { Context, Linked } from "./context";
import { member, propertyKey } from "./emit";
import { ENTITY, prelude, SCHEDULER } from "./prelude";
import type { GeneratedFile, GeneratedTest, GeneratedTestKind } from "./types";

export interface Case {
  name: string;
  linked: Linked;
  /** Statements of the test body, given the impl's call expression (`refundOrder`). */
  body: (impl: string) => string[];
  from?: string;
  actor?: string;
}

/** Helpers the cases may call; each is emitted only when some case uses it. */
const HELPERS = ["seed", "stored", "calls", "otherCalls", "attempt"] as const;
type Helper = (typeof HELPERS)[number];

export interface StateFileInput {
  file: string;
  kind: GeneratedTestKind;
  /** Header "Source:" lines. */
  source: string[];
  cases: Case[];
}

export function stateFile(
  ctx: Context,
  input: StateFileInput,
): { file: GeneratedFile; tests: GeneratedTest[] } | undefined {
  if (input.cases.length === 0) return undefined;
  const impls = input.cases.map((c) => c.linked.invocation.impl);
  const p = prelude(ctx, {
    header: { specFile: ctx.specFile, behavior: ctx.behavior, source: input.source },
    runtime: [],
    impls,
    reserved: [...HELPERS],
  });

  const bodies = input.cases.map((c) => {
    const impl = p.impls.get(`${c.linked.invocation.impl.file}#${c.linked.invocation.impl.symbol}`);
    if (impl === undefined) throw new Error(`testgen: impl of ${c.linked.spec.name} not imported`);
    return c.body(impl);
  });
  const used = new Set<Helper>(
    HELPERS.filter((h) =>
      bodies.some((b) => b.some((line) => new RegExp(`\\b${h}\\(`).test(line))),
    ),
  );

  const { storage } = ctx;
  const field = ctx.spec.entity.stateField;
  const optional = member(field).startsWith(".") ? `?${member(field)}` : `?.${member(field)}`;
  const lines = [...p.lines, ""];
  if (used.has("seed")) {
    lines.push(
      "/** Resets the fakes and stores the entity in `state`. */",
      "function seed(state: string): void {",
      `  ${SCHEDULER}.reset();`,
      `  ${p.store}.seed({ ${propertyKey(storage.collection)}: [{ ...${ENTITY}, ${propertyKey(field)}: state }] });`,
      "}",
      "",
    );
  }
  if (used.has("stored")) {
    lines.push(
      `/** The entity's ${field} as stored now. */`,
      "function stored(): unknown {",
      `  return ${p.store}.read(${JSON.stringify(storage.collection)}, ID)${optional};`,
      "}",
      "",
    );
  }
  if (used.has("calls")) {
    lines.push(
      "/** Calls through one effect gate in this run. */",
      "function calls(gate: string): number {",
      `  return ${SCHEDULER}.effects(gate).length;`,
      "}",
      "",
    );
  }
  if (used.has("otherCalls")) {
    lines.push(
      "/** Effect calls in this run through any gate but `declared`, with their arguments, or `none`. */",
      "function otherCalls(declared: readonly string[]): string {",
      `  const other = ${SCHEDULER}`,
      "    .effects()",
      "    .filter((call) => !declared.includes(call.effect))",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted code contains a template literal
      "    .map((call) => `${call.effect}(${JSON.stringify(call.args).slice(1, -1)})`);",
      '  return other.length === 0 ? "none" : other.join(", ");',
      "}",
      "",
    );
  }
  if (used.has("attempt")) {
    lines.push(
      "/** Calls the impl. A rejection may throw: the test asserts on the state, not on throwing. */",
      "async function attempt(call: () => Promise<unknown>): Promise<void> {",
      "  try {",
      "    await call();",
      "  } catch {",
      "    // rejected by throwing: allowed",
      "  }",
      "}",
      "",
    );
  }

  const tests: GeneratedTest[] = [];
  input.cases.forEach((c, i) => {
    lines.push(`test(${JSON.stringify(c.name)}, async () => {`);
    for (const line of bodies[i] ?? []) lines.push(`  ${line}`);
    lines.push("});", "");
    tests.push(testEntry(input.file, input.kind, c));
  });

  return { file: { path: input.file, content: `${lines.join("\n").trimEnd()}\n` }, tests };
}

function testEntry(file: string, kind: GeneratedTestKind, c: Case): GeneratedTest {
  const t = c.linked.spec;
  const entry: GeneratedTest = { file, name: c.name, kind, transition: t.name };
  if (c.from !== undefined) entry.from = c.from;
  if (c.actor !== undefined) entry.actor = c.actor;
  const specAt: SourceLocation | undefined = t.at;
  if (specAt) entry.specAt = specAt;
  entry.codeAt = c.linked.sites.write;
  return entry;
}

/** `(as admin)` or `(no actor argument)`. */
export function asActor(actor: string | undefined): string {
  return actor === undefined ? "(no actor argument)" : `(as ${actor})`;
}

/** `refundOrder(args)` as the test calls it. */
export function call(impl: string, args: string): string {
  return `${impl}(${args})`;
}
