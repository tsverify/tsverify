// The runtime cannot import @tsverify/ir, so it declares structural input types.
// These checks run in `pnpm typecheck`: if an ir type drifts away from what the runtime reads,
// this file stops compiling.
import type {
  BehaviorModel,
  CallSite,
  CodeSites,
  StorageArg,
  StorageBinding,
  StorageFunction,
  StorageRole,
  Trace,
  TraceStep,
} from "@tsverify/ir";
import { describe, expectTypeOf, test } from "vitest";
import type {
  CallSiteInput,
  CodeModelInput,
  CodeSitesInput,
  ModelActionKind,
  StorageArgInput,
  StorageBindingInput,
  StorageFunctionInput,
  StorageRoleInput,
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

  test("StorageBinding → StorageBindingInput (what instrument.storage takes)", () => {
    expectTypeOf<StorageBinding>().toExtend<StorageBindingInput>();
    expectTypeOf<StorageFunction>().toExtend<StorageFunctionInput>();
    expectTypeOf<StorageRole>().toEqualTypeOf<StorageRoleInput>();
    expectTypeOf<StorageArg>().toExtend<StorageArgInput>();
    expectTypeOf<NonNullable<StorageFunction["returns"]>>().toEqualTypeOf<
      NonNullable<StorageFunctionInput["returns"]>
    >();
  });

  test("the golden JSON files, imported as modules, fit without a cast (what generated tests do)", () => {
    type TraceJson = typeof import("../../checker/test/__golden__/b6-refund-race.trace.json");
    type CodeJson = typeof import("../../extractor/test/__golden__/orders-app.code.json");
    expectTypeOf<TraceJson>().toExtend<TraceInput>();
    expectTypeOf<CodeJson>().toExtend<CodeModelInput>();
    expectTypeOf<TraceJson>().not.toBeAny();
    expectTypeOf<CodeJson>().not.toBeAny();
  });

  test("the structural inputs are not trivially wide", () => {
    expectTypeOf<{ property: string }>().not.toExtend<TraceInput>();
    expectTypeOf<{ effects: [] }>().toExtend<CodeSitesInput>();
    expectTypeOf<{ read: { client: string } }>().not.toExtend<CodeSitesInput>();
  });
});
