// The runtime cannot import @tsv/ir (doc 6 §2 rule 5), so it declares structural input types.
// These checks run in `pnpm typecheck`: if an ir type drifts away from what the runtime reads,
// this file stops compiling.
import type { BehaviorModel, CallSite, CodeSites, Trace, TraceStep } from "@tsv/ir";
import { describe, expectTypeOf, test } from "vitest";
import type {
  CallSiteInput,
  CodeModelInput,
  CodeSitesInput,
  ModelActionKind,
  TraceInput,
  TraceStepInput,
} from "../src/index";
import { ordersAppCode, refundRaceTrace } from "./goldens";

describe("ir types are assignable to the runtime's structural inputs", () => {
  test("Trace → TraceInput", () => {
    expectTypeOf<Trace>().toExtend<TraceInput>();
    expectTypeOf<TraceStep>().toExtend<TraceStepInput>();
    expectTypeOf<NonNullable<TraceStep["action"]>["kind"]>().toEqualTypeOf<ModelActionKind>();
    const input: TraceInput = refundRaceTrace;
    expectTypeOf(input).not.toBeAny();
  });

  test("CodeSites → CodeSitesInput, BehaviorModel → CodeModelInput", () => {
    expectTypeOf<CallSite>().toExtend<CallSiteInput>();
    expectTypeOf<CodeSites>().toExtend<CodeSitesInput>();
    expectTypeOf<BehaviorModel>().toExtend<CodeModelInput>();
    const input: CodeModelInput = ordersAppCode;
    expectTypeOf(input).not.toBeAny();
  });

  test("the structural inputs are not trivially wide", () => {
    expectTypeOf<{ property: string }>().not.toExtend<TraceInput>();
    expectTypeOf<{ effects: [] }>().toExtend<CodeSitesInput>();
    expectTypeOf<{ read: { client: string } }>().not.toExtend<CodeSitesInput>();
  });
});
