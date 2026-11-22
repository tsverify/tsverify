import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BehaviorModel } from "@tsverify/ir";
import { parseSpec } from "@tsverify/spec";
import { describe, expect, it } from "vitest";
import { type ExtractResult, extractAll } from "../src/index";
import { transitionOf } from "./helpers";

// Dogfooding: the replay scheduler's worker lifecycle, extracted with its real behavior file.
const RUNTIME_ROOT = fileURLToPath(new URL("../../runtime/", import.meta.url));
const SPEC_FILE = "src/scheduler.behavior.yaml";

function schedulerSpec(): BehaviorModel {
  const text = readFileSync(`${RUNTIME_ROOT}${SPEC_FILE}`, "utf8");
  const { model, findings } = parseSpec(text, SPEC_FILE);
  if (!model) throw new Error(`invalid spec: ${JSON.stringify(findings)}`);
  return model;
}

describe("runtime scheduler (memory persistence)", () => {
  const spec = schedulerSpec();
  const { results } = extractAll([spec], { projectRoot: RUNTIME_ROOT });
  const result = results[0] as ExtractResult;

  it("reports no findings", () => {
    expect(spec.bindings.persistence).toBe("memory");
    expect(result.findings).toEqual([]);
  });

  it("extracts exactly one code transition per spec transition", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual(
      spec.transitions.map((t) => t.name),
    );
  });

  it.each(schedulerSpec().transitions.map((t) => [t.name, t] as const))(
    "%s links, matches from/to and is synchronously atomic",
    (name, t) => {
      const code = transitionOf(result, name);
      expect(code.sites?.specTransition).toBe(name);
      expect(code.sites?.persistence).toBe("memory");
      expect(code.impl).toEqual(t.impl);
      expect(code.from).toEqual(t.from);
      expect(code.to).toBe(t.to);
      expect(code.sites?.fromState).toEqual({ values: t.from, unconstrained: false });
      expect(t.atomic).toBe(true);
      expect(code.atomic).toBe(true);
      expect(code.sites?.atomic).toEqual({ kind: "synchronous", at: code.sites?.write });
      expect(code.sites?.read).toBeUndefined();
      expect(code.sites?.commit).toBeUndefined();
      expect(code.sites?.storage).toBeUndefined();
      expect(code.sites?.effects).toEqual([]);
    },
  );

  it("records the entity id only where the worker is looked up by id", () => {
    const withInvocation = result.model?.transitions
      .filter((t) => t.sites?.invocation)
      .map((t) => [t.name, t.sites?.invocation?.entityId]);
    // markWaiting / markReady take a worker id; the others take the Worker object itself.
    expect(withInvocation).toEqual([
      ["grant", { param: 0, path: [] }],
      ["wait", { param: 0, path: [] }],
    ]);
  });
});
