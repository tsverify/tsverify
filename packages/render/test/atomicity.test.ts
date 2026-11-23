import type { BehaviorModel, Transition } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { declaredAtomicBy, declaredAtomicTransitions, summarize } from "@tsverify/render";
import { describe, expect, it } from "vitest";

const AT = { file: "src/orders/ship.ts", line: 6, column: 9 };

/** The Order model as code, with `ship` atomic through a declared `withTransaction`. */
function codeModel(): BehaviorModel {
  const model = orderModel();
  model.origin = "code";
  const ship = model.transitions.find((t) => t.name === "ship") as Transition;
  ship.sites = {
    persistence: "functions",
    write: AT,
    function: { file: AT.file, name: "shipOrder", at: AT },
    specTransition: "ship",
    fromState: { values: ["paid"], unconstrained: false },
    atomic: { kind: "declared", at: AT, gate: "storage.withTransaction" },
    guards: [],
    effects: [],
  };
  return model;
}

describe("declared atomicity", () => {
  it("names the function a transition is atomic through by declaration", () => {
    const model = codeModel();
    const ship = model.transitions.find((t) => t.name === "ship") as Transition;
    expect(declaredAtomicBy(ship)).toBe("withTransaction");
    expect(declaredAtomicTransitions(model)).toEqual([
      { transition: "ship", by: "withTransaction" },
    ]);
  });

  it("is not claimed for proven scopes or spec models", () => {
    const model = codeModel();
    const ship = model.transitions.find((t) => t.name === "ship") as Transition;
    if (ship.sites?.atomic) ship.sites.atomic.kind = "conditional-update";
    expect(declaredAtomicBy(ship)).toBeUndefined();
    expect(declaredAtomicTransitions(orderModel())).toEqual([]);
  });

  it("summarize says so instead of a plain `is atomic`", () => {
    const out = summarize(codeModel());
    expect(out).toContain(
      "can move a paid order to shipped. This is atomic, as declared by `withTransaction`.",
    );
    expect(summarize(orderModel())).not.toContain("as declared");
  });
});
