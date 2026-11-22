import { describe, expect, it } from "vitest";
import { extractFixture, libBindings, orderSpec, transitionOf } from "./helpers";

function effectSites(name: string, result: ReturnType<typeof extractFixture>) {
  return transitionOf(result, name).sites?.effects.map((e) => [e.effect, e.gate, e.path]);
}

describe("effects through a bare exported function", () => {
  const ships = ["shipViaReexport", "shipViaAlias", "shipViaNamespace"];
  const spec = (module: string) => {
    const bindings = libBindings();
    bindings.clients = {
      db: bindings.clients.db as (typeof bindings.clients)[string],
      email: { module, export: "sendMail" },
    };
    bindings.effects = { "email.welcome": "email" };
    return orderSpec(
      ships.map((n) => ({
        name: n,
        impl: `src/ship.ts#${n}`,
        to: "shipped",
        effects: [{ name: "email.welcome", multiplicity: "exactly-once" }],
      })),
      bindings,
    );
  };

  for (const module of ["src/notify/email.ts", "src/notify/index.ts"]) {
    describe(`bound at ${module}`, () => {
      const result = extractFixture("effect-function", spec(module));

      it.each(ships)("%s: a direct call is an effect call gated by the client name", (name) => {
        expect(effectSites(name, result)).toEqual([["email.welcome", "email", ""]]);
        expect(transitionOf(result, name).effects).toEqual([
          { name: "email.welcome", multiplicity: "exactly-once" },
        ]);
      });
    });
  }

  it("leaves an unmapped bare client call gated by the client name", () => {
    const s = spec("src/notify/email.ts");
    s.bindings.effects = {};
    const result = extractFixture("effect-function", s);
    expect(effectSites("shipViaAlias", result)).toEqual([["email", "email", ""]]);
  });
});
