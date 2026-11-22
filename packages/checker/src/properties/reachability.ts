import type { Finding } from "@tsverify/ir";
import { STATUS } from "../encode";
import { type CheckContext, type PropertyChecker, propertyFinding } from "./context";

/**
 * The `reachable` built-in: every declared state is observed as `status` in some reachable
 * state. Spec models only (an extracted model's states come from the spec). Skipped when the
 * exploration was cut short, since a missing state might then just be unexplored.
 */
export function reachability(ctx: CheckContext): PropertyChecker {
  const seen = new Uint8Array(ctx.layout.states.length);

  return {
    onState(_id, s) {
      seen[s[STATUS] as number] = 1;
    },

    findings({ complete }) {
      if (ctx.model.origin !== "spec" || !complete) return [];
      const { entity } = ctx.model;
      const out: Finding[] = [];
      ctx.layout.states.forEach((state, i) => {
        if (seen[i] === 1) return;
        out.push(
          propertyFinding(ctx, "reachable", state, {
            severity: "warning",
            message: `State \`${state}\` of ${entity.name} is never reached from \`${entity.initial}\`.`,
            ...(entity.at && { specAt: entity.at }),
            hint: `add a transition into \`${state}\`, or remove the state`,
          }),
        );
      });
      return out;
    },
  };
}
