import { compare } from "@tsverify/conformance";
import type { Actor, BehaviorModel, Transition } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
  MUTATION_CASES,
  patchSpec,
  patchWrite,
  specModel,
  VARIANT_CASES,
  type Write,
} from "./code-model";

describe("guards", () => {
  it("points at the non-dominating guard call and the actor's requires item (B2)", () => {
    const { spec, code } = VARIANT_CASES["b2-guard-bypass"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "guard-not-dominating:Order lifecycle:refund:role(admin)",
        category: "guard-not-dominating",
        severity: "error",
        message:
          "refund: role(admin) (requireRole) is called on some paths but not all before the write (required by actor admin).",
        behavior: "Order lifecycle",
        transition: "refund",
        specAt: { file: "src/orders/order.behavior.yaml", line: 14, column: 44 },
        codeAt: { file: "src/orders/refund.ts", line: 21, column: 3 },
        hint: "Call requireRole on every path from refundOrder to the write, before any early return.",
      },
    ]);
  });

  it("points at the write when the guard is never called", () => {
    const spec = specModel();
    const writes = patchWrite(cleanWrites(), "checkout", (w) => ({ ...w, guards: [] }));
    expect(compare(spec, buildCodeModel(spec, writes))).toEqual([
      expect.objectContaining({
        id: "guard-not-dominating:Order lifecycle:checkout:owner",
        message:
          "checkout: owner (requireOwner) is never called before the write (required by checkout.requires).",
        specAt: { file: "src/orders/order.behavior.yaml", line: 23, column: 16 },
        codeAt: { file: "src/orders/checkout.ts", line: 13, column: 5 },
      }),
    ]);
  });

  it("merges transition and actor requirements, one finding per guard", () => {
    const at = (column: number) => ({ file: "src/orders/order.behavior.yaml", line: 49, column });
    const spec = patchSpec(specModel(), "ship", (t) => ({
      ...t,
      requires: [
        { name: "role", args: ["admin"], raw: "role(admin)", at: at(16) },
        { name: "owner", args: [], raw: "owner", at: at(29) },
      ],
    }));
    const writes = patchWrite(cleanWrites(), "ship", (w) => ({ ...w, guards: [] }));
    const findings = compare(spec, buildCodeModel(spec, writes));
    expect(findings.map((f) => f.message)).toEqual([
      "ship: owner (requireOwner) is never called before the write (required by ship.requires).",
      "ship: role(admin) (requireRole) is never called before the write (required by ship.requires, actor admin).",
    ]);
    // A guard the transition lists points at that item, not at the actor's.
    expect(findings.map((f) => f.specAt)).toEqual([at(29), at(16)]);
  });

  it("falls back to the transition when the requires item has no location", () => {
    const spec = patchSpec(specModel(), "checkout", (t) => ({
      ...t,
      requires: t.requires.map(({ at: _, ...g }) => g),
    }));
    const writes = patchWrite(cleanWrites(), "checkout", (w) => ({ ...w, guards: [] }));
    expect(compare(spec, buildCodeModel(spec, writes))[0]?.specAt).toEqual({
      file: "src/orders/order.behavior.yaml",
      line: 19,
      column: 3,
    });
  });

  it("ignores guards the code calls but the spec does not require", () => {
    const spec = specModel();
    const writes = patchWrite(cleanWrites(), "expire", (w) => ({
      ...w,
      guards: [{ guard: "role(admin)", at: [10, 3], dominates: false }],
    }));
    expect(compare(spec, buildCodeModel(spec, writes))).toEqual([]);
  });
});

const SPEC = "src/orders/order.behavior.yaml";

/**
 * `by: [customer, admin]` on `ship`, with `customer` requiring `owner` (on line 11): either
 * actor may ship, the customer when it owns the order, the admin by role.
 */
function ownerOrAdmin(patch: (t: Transition) => Transition = (t) => t): BehaviorModel {
  const spec = patchSpec(specModel(), "ship", (t) =>
    patch({
      ...t,
      by: ["customer", "admin"],
      byAt: [
        { file: SPEC, line: 48, column: 10 },
        { file: SPEC, line: 48, column: 20 },
      ],
    }),
  );
  spec.actors.customer = {
    ...(spec.actors.customer as Actor),
    requires: [{ name: "owner", args: [], raw: "owner", at: { file: SPEC, line: 11, column: 44 } }],
  };
  return spec;
}

type GuardCall = Write["guards"][number];
const OWNER_CALL: GuardCall = { guard: "owner", at: [12, 5], dominates: false };
const ROLE_CALL: GuardCall = { guard: "role(admin)", at: [9, 3], dominates: false };

function shipWith(spec: BehaviorModel, patch: Partial<Write>) {
  const writes = patchWrite(cleanWrites(), "ship", (w) => ({ ...w, ...patch }));
  return compare(spec, buildCodeModel(spec, writes));
}

describe("guards: by lists alternatives (any listed actor)", () => {
  it("accepts owner-or-admin code: each path passes one actor's guards", () => {
    expect(
      shipWith(ownerOrAdmin(), {
        guards: [ROLE_CALL, OWNER_CALL],
        guardSets: [["owner"], ["role(admin)"]],
      }),
    ).toEqual([]);
  });

  it("accepts code that passes every actor's guards on one path", () => {
    expect(
      shipWith(ownerOrAdmin(), {
        guards: [
          { ...ROLE_CALL, dominates: true },
          { ...OWNER_CALL, dominates: true },
        ],
        guardSets: [["owner", "role(admin)"]],
      }),
    ).toEqual([]);
  });

  it("reports a path that passes no listed actor's guards, once per set", () => {
    const findings = shipWith(ownerOrAdmin(), {
      guards: [ROLE_CALL, OWNER_CALL],
      guardSets: [[], ["role(admin)"], [], ["owner"]],
    });
    expect(findings).toEqual([
      {
        id: "guard-not-dominating:Order lifecycle:ship:path:{}",
        category: "guard-not-dominating",
        severity: "error",
        message:
          "ship: shipOrder reaches the write on a path that passes no guard; it must pass owner to act as customer, or role(admin) to act as admin.",
        behavior: "Order lifecycle",
        transition: "ship",
        // Both actors miss one guard: the first in `by` is the closest.
        specAt: { file: SPEC, line: 11, column: 44 },
        codeAt: { file: "src/admin/orders.ts", line: 12, column: 5 },
        hint: "Call requireOwner (as customer) or requireRole (as admin) on every path from shipOrder to the write, before any early return.",
      },
    ]);
  });

  it("names what each actor misses, closest actor first", () => {
    const spec = ownerOrAdmin();
    const mfa = { name: "mfa", args: [], raw: "mfa", at: { file: SPEC, line: 14, column: 58 } };
    const admin = spec.actors.admin as Actor;
    spec.actors.admin = { ...admin, requires: [...admin.requires, mfa] };
    const customer = spec.actors.customer as Actor;
    spec.actors.customer = {
      ...customer,
      requires: [...customer.requires, { name: "kyc", args: [], raw: "kyc" }],
    };
    const findings = shipWith(spec, {
      guards: [ROLE_CALL, OWNER_CALL, { guard: "mfa", at: [10, 3], dominates: false }],
      guardSets: [["mfa", "role(admin)"], ["kyc", "owner"], ["role(admin)"]],
    });
    expect(
      findings
        .filter((f) => f.transition === "ship")
        .map((f) => [f.id, f.message, f.specAt, f.codeAt, f.hint]),
    ).toEqual([
      [
        "guard-not-dominating:Order lifecycle:ship:path:{role(admin)}",
        "ship: shipOrder reaches the write on a path that passes only {role(admin)}; it must pass mfa to act as admin, or owner and kyc to act as customer.",
        mfa.at,
        { file: "src/admin/orders.ts", line: 10, column: 3 },
        "Call the mfa guard (as admin) or requireOwner and the kyc guard (as customer) on every path from shipOrder to the write, before any early return.",
      ],
    ]);
  });

  it("checks the transition's own requires on every path, for every actor", () => {
    const at = { file: SPEC, line: 49, column: 16 };
    const spec = ownerOrAdmin((t) => ({
      ...t,
      requires: [{ name: "verified", args: [], raw: "verified", at }],
    }));
    const findings = shipWith(spec, {
      guards: [ROLE_CALL, OWNER_CALL, { guard: "verified", at: [10, 3], dominates: false }],
      guardSets: [["owner"], ["role(admin)", "verified"]],
    });
    expect(findings.map((f) => [f.id, f.message, f.specAt])).toEqual([
      [
        "guard-not-dominating:Order lifecycle:ship:verified",
        "ship: verified (the verified guard) is called on some paths but not all before the write (required by ship.requires).",
        at,
      ],
    ]);
  });

  it("requires nothing more when a listed actor has no guards of its own", () => {
    const spec = patchSpec(specModel(), "ship", (t) => ({ ...t, by: ["admin", "system"] }));
    expect(shipWith(spec, { guards: [], guardSets: [[]] })).toEqual([]);
  });

  it("requires the shared guards one by one when every listed actor has the same ones", () => {
    const spec = patchSpec(specModel(), "ship", (t) => ({ ...t, by: ["admin", "ops"] }));
    spec.actors.ops = {
      name: "ops",
      trust: "authenticated",
      requires: [{ name: "role", args: ["admin"], raw: "role(admin)" }],
    };
    expect(shipWith(spec, { guards: [], guardSets: [[]] }).map((f) => f.message)).toEqual([
      "ship: role(admin) (requireRole) is never called before the write (required by actor admin, actor ops).",
    ]);
  });

  describe("without guardSets (the extractor could not enumerate the paths)", () => {
    it("accepts code whose dominating guards are one actor's", () => {
      const guards = [{ ...OWNER_CALL, dominates: true }, ROLE_CALL];
      expect(shipWith(ownerOrAdmin(), { guards })).toEqual([]);
    });

    it("falls back to dominance: one finding when no actor's guards all dominate", () => {
      expect(shipWith(ownerOrAdmin(), { guards: [ROLE_CALL, OWNER_CALL] })).toEqual([
        expect.objectContaining({
          id: "guard-not-dominating:Order lifecycle:ship:path:*",
          message:
            "ship: shipOrder may reach the write without passing all of one listed actor's guards (no guard is called on every path); it must pass owner to act as customer, or role(admin) to act as admin.",
          specAt: { file: SPEC, line: 11, column: 44 },
          codeAt: { file: "src/admin/orders.ts", line: 12, column: 5 },
        }),
      ]);
    });

    it("names the dominating guards", () => {
      const spec = ownerOrAdmin();
      const customer = spec.actors.customer as Actor;
      spec.actors.customer = {
        ...customer,
        requires: [...customer.requires, { name: "mfa", args: [], raw: "mfa" }],
      };
      const guards = [{ ...OWNER_CALL, dominates: true }, ROLE_CALL];
      const ship = shipWith(spec, { guards }).filter((f) => f.transition === "ship");
      expect(ship.map((f) => f.message)).toEqual([
        "ship: shipOrder may reach the write without passing all of one listed actor's guards (only {owner} is called on every path); it must pass mfa to act as customer, or role(admin) to act as admin.",
      ]);
    });
  });
});

describe("guards: a single actor in by behaves as before", () => {
  const cases = { ...VARIANT_CASES, ...MUTATION_CASES };
  it.each(Object.keys(cases))("%s: guardSets of the dominating guards change nothing", (id) => {
    const { spec, code } = cases[id as keyof typeof cases]();
    const withSets = structuredClone(code);
    for (const t of withSets.transitions) {
      if (t.sites !== undefined) t.sites.guardSets = [t.requires.map((g) => g.raw)];
    }
    expect(compare(spec, withSets)).toEqual(compare(spec, code));
  });

  it("stays guard by guard when a path skips the guard (B2 with guardSets)", () => {
    const { spec, code } = VARIANT_CASES["b2-guard-bypass"]();
    const withSets = structuredClone(code);
    const refund = withSets.transitions.find((t) => t.name === "refund");
    if (refund?.sites) refund.sites.guardSets = [[], ["role(admin)"]];
    expect(compare(spec, withSets)).toEqual(compare(spec, code));
  });
});
