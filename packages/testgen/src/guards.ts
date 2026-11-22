/**
 * Guard tests (`guards.test.ts`): for each drivable transition whose impl takes an actor, and
 * each actor with a fixture that is not in its `by`, the impl is called from the first allowed
 * from-state as that actor; the stored state must be unchanged and no declared effect may fire.
 */

import type { Finding } from "@tsverify/ir";
import type { Context } from "./context";
import { rejectedBody } from "./forbidden";
import { buildArgs } from "./invoke";
import { fromStates } from "./paths";
import { skipFinding } from "./skips";
import { type Case, call, stateFile } from "./state-file";
import type { GeneratedFile, GeneratedTest } from "./types";

export const GUARDS_FILE = "guards.test.ts";

export function guardsFile(ctx: Context): {
  file?: GeneratedFile;
  tests: GeneratedTest[];
  skipped: Finding[];
} {
  const cases: Case[] = [];
  const skipped: Finding[] = [];
  const actors = Object.keys(ctx.fixtures.actors);
  for (const linked of ctx.linked.values()) {
    const t = linked.spec;
    const outsiders = actors.filter((a) => !t.by.includes(a));
    if (outsiders.length === 0) continue;
    if (!linked.takesActor) {
      skipped.push(
        skipFinding(
          ctx.behavior,
          `guards:${t.name}`,
          `tsverify test generated no guard tests for \`${t.name}\`: ${linked.invocation.impl.symbol} takes no actor, so the actors not allowed to perform it (${outsiders.join(", ")}) cannot be passed in`,
          { transition: t.name, ...(t.at ? { specAt: t.at } : {}) },
        ),
      );
      continue;
    }
    const [from] = fromStates(ctx, linked);
    if (from === undefined) continue;
    for (const actor of outsiders) {
      const built = buildArgs(linked.invocation, linked.fixtureArgs, actor);
      if (!built.ok) {
        skipped.push(
          skipFinding(ctx.behavior, `guards:${t.name}:${actor}`, built.reason, {
            transition: t.name,
            ...(t.at ? { specAt: t.at } : {}),
          }),
        );
        continue;
      }
      cases.push({
        name: `${t.name} as ${actor} (not in by: ${t.by.join(", ")}) is rejected from ${from}`,
        linked,
        from,
        actor,
        body: (impl) => rejectedBody(ctx, linked, from, call(impl, built.args)),
      });
    }
  }
  const out = stateFile(ctx, {
    file: GUARDS_FILE,
    kind: "guard",
    source: [
      "guard tests, one per transition and actor (with a fixture) not allowed to perform it:",
      [...new Set(cases.map((c) => c.linked.spec.name))].join(", "),
    ],
    cases,
  });
  return out === undefined ? { tests: [], skipped } : { ...out, skipped };
}
