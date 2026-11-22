/**
 * Path tests (`paths.test.ts`): one per drivable transition and allowed from-state. The entity
 * is seeded in the from-state, the impl is called once as a permitted actor, and the test
 * asserts the stored state is `to`, each declared exactly-once effect was called exactly once
 * (at-least-once / idempotent: at least once), and no other effect call happened.
 */
import type { Context, Linked } from "./context";
import { effectGate } from "./context";
import { asActor, type Case, call, stateFile } from "./state-file";
import type { GeneratedFile, GeneratedTest } from "./types";

export const PATHS_FILE = "paths.test.ts";

export function pathsFile(
  ctx: Context,
): { file: GeneratedFile; tests: GeneratedTest[] } | undefined {
  const cases: Case[] = [];
  for (const linked of ctx.linked.values()) {
    for (const from of fromStates(ctx, linked)) {
      const t = linked.spec;
      cases.push({
        name: `${t.name}: ${from} → ${t.to} ${asActor(linked.actor)}`,
        linked,
        from,
        ...(linked.actor === undefined ? {} : { actor: linked.actor }),
        body: (impl) => pathBody(ctx, linked, from, impl),
      });
    }
  }
  return stateFile(ctx, {
    file: PATHS_FILE,
    kind: "path",
    source: [
      "path tests, one per transition and allowed from-state:",
      [...ctx.linked.keys()].join(", "),
    ],
    cases,
  });
}

/** The spec's allowed from-states (`*` = every state). */
export function fromStates(ctx: Context, linked: Linked): string[] {
  const { from } = linked.spec;
  return from === "*" ? [...ctx.spec.entity.states] : [...from];
}

function pathBody(ctx: Context, linked: Linked, from: string, impl: string): string[] {
  const t = linked.spec;
  const field = ctx.spec.entity.stateField;
  const lines = [
    `seed(${JSON.stringify(from)});`,
    `await ${call(impl, linked.args)};`,
    `expect(stored(), "stored ${field}").toBe(${JSON.stringify(t.to)});`,
  ];
  const declared: string[] = [];
  for (const effect of t.effects) {
    const gate = effectGate(ctx, effect.name);
    declared.push(gate);
    const label = JSON.stringify(`${effect.name} (${effect.multiplicity}) via ${gate}`);
    lines.push(
      effect.multiplicity === "exactly-once"
        ? `expect(calls(${JSON.stringify(gate)}), ${label}).toBe(1);`
        : `expect(calls(${JSON.stringify(gate)}), ${label}).toBeGreaterThanOrEqual(1);`,
    );
  }
  lines.push(
    `const other = otherCalls(${JSON.stringify([...new Set(declared)])});`,
    `expect(other, \`effect calls ${t.name} does not declare: \${other}\`).toBe("none");`,
  );
  return lines;
}
