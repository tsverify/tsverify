import { compare } from "@tsv/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanCase,
  cleanWrites,
  patchSpec,
  patchWrite,
  specModel,
} from "./code-model";

describe("compare", () => {
  it("reports nothing for the clean app", () => {
    const { spec, code } = cleanCase();
    expect(compare(spec, code)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const { spec, code } = cleanCase();
    const before = structuredClone({ spec, code });
    compare(spec, code);
    expect({ spec, code }).toEqual(before);
  });

  it("throws unless given a spec model and a code model, in that order", () => {
    const { spec, code } = cleanCase();
    expect(() => compare(code, code)).toThrow(/must be a spec model, got origin "code"/);
    expect(() => compare(spec, spec)).toThrow(/must be a code model, got origin "spec"/);
  });

  it("throws when the entities differ", () => {
    const { spec, code } = cleanCase();
    const other = { ...code, entity: { ...code.entity, name: "Invoice" } };
    expect(() => compare(spec, other)).toThrow(/entity mismatch: spec "Order" vs. code "Invoice"/);
  });

  it("throws when the code model breaks the extractor conventions", () => {
    const spec = specModel();
    const code = buildCodeModel(spec, cleanWrites());
    const noSites = {
      ...code,
      transitions: code.transitions.map((t) =>
        t.name === "ship" ? { ...t, sites: undefined } : t,
      ),
    };
    expect(() => compare(spec, noSites)).toThrow(/code transition "ship" has no sites/);

    const unknown = buildCodeModel(
      spec,
      patchWrite(cleanWrites(), "ship", (w) => ({ ...w, specTransition: "dispatch" })),
    );
    expect(() => compare(spec, unknown)).toThrow(/links to unknown spec transition "dispatch"/);

    const noImplSpec = patchSpec(spec, "ship", ({ impl: _, ...t }) => t);
    expect(() => compare(noImplSpec, code)).toThrow(
      /links to spec transition "ship", which has no impl/,
    );
  });
});
