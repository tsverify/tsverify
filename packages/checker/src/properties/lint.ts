import type { Actor, Finding, Transition } from "@tsv/ir";
import { type CheckContext, propertyFinding } from "./context";

function actorsOf(ctx: CheckContext, t: Transition): Actor[] {
  return t.by.flatMap((name) => {
    const actor = ctx.model.actors[name];
    return actor ? [actor] : [];
  });
}

function names(actors: readonly Actor[]): string {
  return actors.map((a) => `\`${a.name}\``).join(", ");
}

/**
 * Structural built-ins, checked without exploration. Spec models only: they judge the design,
 * and an extracted model inherits actors and flags from its spec.
 *
 * - untrusted-guarded:  a transition an `untrusted` actor performs has some guard (its own
 *                       `requires` or that actor's `requires`).
 * - webhook-idempotent: a transition a `signed-webhook` actor performs is `idempotent`.
 */
export function lint(ctx: CheckContext): Finding[] {
  if (ctx.model.origin !== "spec") return [];
  const out: Finding[] = [];
  for (const t of ctx.model.transitions) {
    const actors = actorsOf(ctx, t);

    const unguarded = actors.filter(
      (a) => a.trust === "untrusted" && t.requires.length === 0 && a.requires.length === 0,
    );
    if (unguarded.length > 0) {
      out.push(
        propertyFinding(ctx, "untrusted-guarded", t.name, {
          severity: "error",
          message: `Transition \`${t.name}\` can be performed by untrusted actor ${names(unguarded)} without any guard.`,
          transition: t.name,
          ...(t.at && { specAt: t.at }),
          hint: `add \`requires:\` to \`${t.name}\` (e.g. \`owner\`)`,
        }),
      );
    }

    const webhooks = actors.filter((a) => a.trust === "signed-webhook");
    if (webhooks.length > 0 && !t.idempotent) {
      out.push(
        propertyFinding(ctx, "webhook-idempotent", t.name, {
          severity: "error",
          message: `Transition \`${t.name}\` is triggered by signed-webhook actor ${names(webhooks)} but is not idempotent; webhooks can be delivered more than once.`,
          transition: t.name,
          ...(t.at && { specAt: t.at }),
          hint: `set \`idempotent: true\` on \`${t.name}\` and make it safe to redeliver`,
        }),
      );
    }
  }
  return out;
}
