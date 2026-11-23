/**
 * Guard tests (`guards.test.ts`), for each drivable transition whose impl takes an actor, called
 * from the first allowed from-state. `by: [a, b]` lists alternatives: any one listed actor may
 * perform the transition, passing its own guards.
 * - Each actor with a fixture that is not in `by` is rejected: the stored state is unchanged
 *   and no declared effect fires.
 * - Each other actor in `by` with a fixture (the path tests already act as the first) succeeds
 *   on its own, like a path test. No test acts as several actors at once.
 * A caller acting as a listed actor but failing one of its guards cannot be expressed:
 * `fixtures.actors` holds one value per actor, which passes that actor's guards. For a
 * multi-actor `by` that is reported as `not-generated`, with listed actors that have no fixture.
 */

import type { Finding, Transition } from "@tsverify/ir";
import type { Context, Linked } from "./context";
import { rejectedBody } from "./forbidden";
import { buildArgs } from "./invoke";
import { fromStates, pathBody } from "./paths";
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
    const where = { transition: t.name, ...(t.at ? { specAt: t.at } : {}) };
    const outsiders = actors.filter((a) => !t.by.includes(a));
    const listed = [...new Set(t.by)];
    const alternatives = listed.length > 1;
    if (outsiders.length === 0 && !alternatives) continue;
    if (!linked.takesActor) {
      if (outsiders.length > 0) {
        skipped.push(
          skipFinding(
            ctx.behavior,
            `guards:${t.name}`,
            `tsverify test generated no guard tests for \`${t.name}\`: ${linked.impl.symbol} takes no actor, so the actors not allowed to perform it (${outsiders.join(", ")}) cannot be passed in`,
            where,
          ),
        );
      }
      continue;
    }
    const [from] = fromStates(ctx, linked);
    if (from === undefined) continue;
    for (const actor of outsiders) {
      const built = buildArgs(linked.invocation, linked.fixtureArgs, actor);
      if (!built.ok) {
        skipped.push(skipFinding(ctx.behavior, `guards:${t.name}:${actor}`, built.reason, where));
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
    if (alternatives) {
      cases.push(...alternativeCases(ctx, linked, from, skipped));
      const failing = failingGuardSkip(ctx, t, where);
      if (failing !== undefined) skipped.push(failing);
    }
  }
  const out = stateFile(ctx, {
    file: GUARDS_FILE,
    kind: "guard",
    source: [
      cases.some((c) => c.linked.spec.by.includes(c.actor ?? ""))
        ? "guard tests, one per transition and actor (with a fixture) not allowed to perform it, and one per other actor allowed in a multi-actor by:"
        : "guard tests, one per transition and actor (with a fixture) not allowed to perform it:",
      [...new Set(cases.map((c) => c.linked.spec.name))].join(", "),
    ],
    cases,
  });
  return out === undefined ? { tests: [], skipped } : { ...out, skipped };
}

/** One success test per listed actor besides the one the path tests act as. */
function alternativeCases(ctx: Context, linked: Linked, from: string, skipped: Finding[]): Case[] {
  const t = linked.spec;
  const where = { transition: t.name, ...(t.at ? { specAt: t.at } : {}) };
  const cases: Case[] = [];
  for (const actor of new Set(t.by)) {
    if (actor === linked.actor) continue;
    if (!Object.hasOwn(ctx.fixtures.actors, actor)) {
      skipped.push(
        skipFinding(
          ctx.behavior,
          `guards:${t.name}:${actor}`,
          `tsverify test generated no test of \`${t.name}\` acting as ${actor}: ${actor} is one of the actors in its by (${t.by.join(", ")}) but has no fixture`,
          { ...where, hint: `Add a value for ${actor} under \`fixtures.actors\`.` },
        ),
      );
      continue;
    }
    const built = buildArgs(linked.invocation, linked.fixtureArgs, actor);
    if (!built.ok) {
      skipped.push(skipFinding(ctx.behavior, `guards:${t.name}:${actor}`, built.reason, where));
      continue;
    }
    cases.push({
      name: `${t.name} as ${actor} (one of by: ${t.by.join(", ")}) succeeds from ${from}`,
      linked,
      from,
      actor,
      body: (impl) => pathBody(ctx, linked, from, impl, built.args),
    });
  }
  return cases;
}

function failingGuardSkip(
  ctx: Context,
  t: Transition,
  where: { transition: string; specAt?: Transition["at"] },
): Finding | undefined {
  const own = new Set(t.requires.map((g) => g.raw));
  const guards = [...new Set(t.by)].flatMap((a) => {
    const extra = (ctx.spec.actors[a]?.requires ?? []).filter((g) => !own.has(g.raw));
    return extra.length === 0 ? [] : [`${a}: ${extra.map((g) => g.raw).join(", ")}`];
  });
  if (guards.length === 0 && t.requires.length === 0) return undefined;
  if (t.requires.length > 0) guards.push(`everyone: ${t.requires.map((g) => g.raw).join(", ")}`);
  return skipFinding(
    ctx.behavior,
    `guards:${t.name}:failing`,
    `tsverify test generated no test of \`${t.name}\` acting as one of its actors but failing that actor's guards (${guards.join("; ")}): \`fixtures.actors\` holds one value per actor, which passes its guards. The static check covers these (guard-not-dominating).`,
    where,
  );
}
