import type { Trace } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import { toItf } from "./itf";

const trace: Trace = {
  behavior: "B",
  model: "code",
  property: "effect-multiplicity",
  kind: "invariant",
  steps: [
    {
      index: 0,
      state: {
        status: "a",
        effects: { "z.e": 0, "a.e": 0 },
        workers: [{ id: "t#1", transition: "t", phase: "idle" }],
      },
    },
    {
      index: 1,
      action: { worker: "t#1", transition: "t", kind: "read", outcome: "proceed", duplicate: true },
      state: {
        status: "a",
        effects: { "z.e": 0, "a.e": 0 },
        workers: [{ id: "t#1", transition: "t", phase: "checked", observed: "a", duplicate: true }],
      },
    },
  ],
};

describe("toItf", () => {
  it("encodes states with ITF maps, bigints and Quint-style variants", () => {
    expect(toItf(trace)).toEqual({
      "#meta": {
        format: "ITF",
        "format-description": "https://apalache-mc.org/docs/adr/015adr-trace.html",
        description: "tsv counterexample: effect-multiplicity in B",
        behavior: "B",
        model: "code",
        property: "effect-multiplicity",
        kind: "invariant",
      },
      vars: ["status", "effects", "workers", "action"],
      states: [
        {
          "#meta": { index: 0 },
          status: "a",
          effects: {
            "#map": [
              ["a.e", { "#bigint": "0" }],
              ["z.e", { "#bigint": "0" }],
            ],
          },
          workers: {
            "#map": [
              [
                "t#1",
                {
                  transition: "t",
                  phase: "idle",
                  observed: { tag: "None", value: { "#tup": [] } },
                  duplicate: false,
                },
              ],
            ],
          },
          action: { tag: "Init", value: { "#tup": [] } },
        },
        {
          "#meta": { index: 1 },
          status: "a",
          effects: {
            "#map": [
              ["a.e", { "#bigint": "0" }],
              ["z.e", { "#bigint": "0" }],
            ],
          },
          workers: {
            "#map": [
              [
                "t#1",
                {
                  transition: "t",
                  phase: "checked",
                  observed: { tag: "Some", value: "a" },
                  duplicate: true,
                },
              ],
            ],
          },
          action: { tag: "Read", value: { worker: "t#1", transition: "t", duplicate: true } },
        },
      ],
    });
  });

  it("is JSON round-trippable", () => {
    const itf = toItf(trace);
    expect(JSON.parse(JSON.stringify(itf))).toEqual(itf);
  });
});
