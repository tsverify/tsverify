/**
 * Forbidden tests (`forbidden.test.ts`): for each drivable transition and each state outside its
 * `from`, the same invocation as the path test must leave the stored state unchanged and fire
 * none of the transition's declared effects. Throwing is an allowed way to reject: the test
 * asserts on the state, not on the throw.
 */
import { type Context, effectGate, type Linked } from "./context";
import { fromStates } from "./paths";
import { asActor, type Case, call, stateFile } from "./state-file";
import type { GeneratedFile, GeneratedTest } from "./types";

export const FORBIDDEN_FILE = "forbidden.test.ts";

export function forbiddenFile(
  ctx: Context,
): { file: GeneratedFile; tests: GeneratedTest[] } | undefined {
  const cases: Case[] = [];
  for (const linked of ctx.linked.values()) {
    const allowed = new Set(fromStates(ctx, linked));
    for (const state of ctx.spec.entity.states) {
      if (allowed.has(state)) continue;
      const t = linked.spec;
      cases.push({
        name: `${t.name} from ${state} is rejected ${asActor(linked.actor)}`,
        linked,
        from: state,
        ...(linked.actor === undefined ? {} : { actor: linked.actor }),
        body: (impl) => rejectedBody(ctx, linked, state, call(impl, linked.args)),
      });
    }
  }
  return stateFile(ctx, {
    file: FORBIDDEN_FILE,
    kind: "forbidden",
    source: [
      "forbidden tests, one per transition and state outside its `from`:",
      [...ctx.linked.keys()].join(", "),
    ],
    cases,
  });
}

/** Shared with the guard tests: call, then the state is unchanged and no declared effect fired. */
export function rejectedBody(
  ctx: Context,
  linked: Linked,
  state: string,
  invoke: string,
): string[] {
  const field = ctx.spec.entity.stateField;
  const lines = [
    `seed(${JSON.stringify(state)});`,
    `await attempt(() => ${invoke});`,
    `expect(stored(), "stored ${field} (unchanged)").toBe(${JSON.stringify(state)});`,
  ];
  for (const effect of linked.spec.effects) {
    const gate = effectGate(ctx, effect.name);
    lines.push(
      `expect(calls(${JSON.stringify(gate)}), ${JSON.stringify(`${effect.name} via ${gate} must not fire`)}).toBe(0);`,
    );
  }
  return lines;
}
