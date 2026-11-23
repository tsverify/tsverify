import type { BehaviorModel } from "@tsverify/ir";
import { parseSymbolRef } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { extractFixture, transitionOf } from "./helpers";

// `persistence: memory`: in-process objects, atomic = no suspension between the last re-check of
// the state field (else the impl's entry) and the write.

const STATES = ["queued", "running", "done", "failed"];

interface JobTransition {
  name: string;
  impl: string;
  from: string;
  to: string;
}

function jobSpec(transitions: JobTransition[], atomic = true): BehaviorModel {
  const ts = transitions
    .map((t) => ({
      name: t.name,
      from: [t.from],
      to: t.to,
      by: ["system"],
      requires: [],
      effects: [],
      atomic,
      idempotent: false,
      impl: parseSymbolRef(t.impl) ?? { file: "?", symbol: "?" },
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    kind: "entity",
    name: "Jobs",
    origin: "spec",
    entity: {
      name: "Job",
      stateField: "status",
      states: STATES,
      initial: "queued",
      terminal: ["done", "failed"],
    },
    actors: { system: { name: "system", trust: "internal", requires: [] } },
    transitions: ts,
    rules: [],
    concurrency: Object.fromEntries(ts.map((t) => [t.name, 2])),
    bindings: { persistence: "memory", clients: {}, guards: {}, effects: {} },
  };
}

const atomicity = (result: ReturnType<typeof extractFixture>, name: string) => {
  const t = transitionOf(result, name);
  return { atomic: t.atomic, scope: t.sites?.atomic?.kind };
};

describe("memory: synchronous check and write", () => {
  const result = extractFixture(
    "memory-sync",
    jobSpec([
      { name: "start", impl: "src/jobs.ts#startJob", from: "queued", to: "running" },
      { name: "finish", impl: "src/jobs.ts#finishJob", from: "running", to: "done" },
      { name: "fail", impl: "src/jobs.ts#failJob", from: "running", to: "failed" },
    ]),
  );

  it("is atomic, with a synchronous scope at the write", () => {
    const t = transitionOf(result, "start");
    expect(t.atomic).toBe(true);
    expect(t.from).toEqual(["queued"]);
    expect(t.sites?.fromState).toEqual({ values: ["queued"], unconstrained: false });
    expect(t.sites?.persistence).toBe("memory");
    expect(t.sites?.write).toMatchObject({ file: "src/jobs.ts", line: 12, column: 3 });
    expect(t.sites?.atomic).toEqual({ kind: "synchronous", at: t.sites?.write });
  });

  it("has no read, commit, storage or invocation (the entity is the parameter itself)", () => {
    const t = transitionOf(result, "start");
    expect(t.sites?.read).toBeUndefined();
    expect(t.sites?.commit).toBeUndefined();
    expect(t.sites?.storage).toBeUndefined();
    expect(t.sites?.invocation).toBeUndefined();
  });

  it("ignores awaits after the write, in unawaited helpers, and in other callbacks", () => {
    expect(atomicity(result, "finish")).toEqual({ atomic: true, scope: "synchronous" });
    expect(atomicity(result, "fail")).toEqual({ atomic: true, scope: "synchronous" });
  });

  it("reports no findings (no 'no read through a bound client' warnings)", () => {
    expect(result.findings).toEqual([]);
  });
});

describe("memory: await between the check and the write", () => {
  const result = extractFixture(
    "memory-await",
    jobSpec([
      { name: "start", impl: "src/jobs.ts#startJob", from: "queued", to: "running" },
      { name: "finish", impl: "src/jobs.ts#finishJob", from: "running", to: "done" },
      { name: "drain", impl: "src/jobs.ts#drainJob", from: "running", to: "done" },
      { name: "step", impl: "src/jobs.ts#stepJob", from: "queued", to: "running" },
      { name: "failLater", impl: "src/jobs.ts#failLater", from: "running", to: "failed" },
    ]),
  );

  it.each([["start"], ["finish"], ["drain"], ["step"], ["failLater"]])(
    "%s is not atomic and has no atomic scope",
    (name) => {
      expect(atomicity(result, name)).toEqual({ atomic: false, scope: undefined });
    },
  );

  it("still narrows the from-state (narrowing survives the await)", () => {
    expect(transitionOf(result, "start").from).toEqual(["queued"]);
  });

  it("reports no unanalyzable read warnings", () => {
    expect(result.findings.filter((f) => f.id.includes(":read:"))).toEqual([]);
  });
});

describe("memory: await inside a helper on the path", () => {
  const result = extractFixture(
    "memory-helper-await",
    jobSpec([
      { name: "start", impl: "src/jobs.ts#startJob", from: "queued", to: "running" },
      { name: "finish", impl: "src/jobs.ts#finishJob", from: "running", to: "done" },
      { name: "fail", impl: "src/jobs.ts#failJob", from: "running", to: "failed" },
    ]),
  );

  it("an await in the helper before its write: not atomic", () => {
    const t = transitionOf(result, "start");
    expect(t.sites?.function.name).toBe("markRunning");
    expect(t.from).toEqual(["queued"]);
    expect(atomicity(result, "start")).toEqual({ atomic: false, scope: undefined });
  });

  it("an await in a middle frame of impl → helper → helper: not atomic", () => {
    expect(transitionOf(result, "finish").sites?.function.name).toBe("setDone");
    expect(atomicity(result, "finish")).toEqual({ atomic: false, scope: undefined });
  });

  it("an await in the helper after its write: atomic", () => {
    expect(atomicity(result, "fail")).toEqual({ atomic: true, scope: "synchronous" });
  });
});

describe("memory: re-check after the await", () => {
  const result = extractFixture(
    "memory-recheck",
    jobSpec([
      { name: "rechecked", impl: "src/jobs.ts#startRechecked", from: "queued", to: "running" },
      { name: "stale", impl: "src/jobs.ts#startStale", from: "queued", to: "running" },
      { name: "maybe", impl: "src/jobs.ts#finishMaybe", from: "running", to: "done" },
      { name: "other", impl: "src/jobs.ts#failOther", from: "running", to: "failed" },
      { name: "viaHelper", impl: "src/jobs.ts#startViaHelper", from: "queued", to: "running" },
      { name: "later", impl: "src/jobs.ts#failLater", from: "running", to: "failed" },
      { name: "inHelper", impl: "src/jobs.ts#finishInHelper", from: "running", to: "done" },
    ]),
  );

  it.each([["rechecked"], ["viaHelper"], ["later"], ["inHelper"]])(
    "%s: no suspension between the last re-check and the write: atomic",
    (name) => {
      expect(atomicity(result, name)).toEqual({ atomic: true, scope: "synchronous" });
    },
  );

  it.each([["stale"], ["maybe"], ["other"]])(
    "%s: a suspension after the last re-check on some path: not atomic",
    (name) => {
      expect(atomicity(result, name)).toEqual({ atomic: false, scope: undefined });
    },
  );

  it("does not count the narrowing probe as a re-check", () => {
    // Without the probe exclusion every write would be "re-checked" right before itself.
    expect(transitionOf(result, "stale").from).toEqual(["queued"]);
    expect(result.findings).toEqual([]);
  });
});

describe("memory: this-based entity", () => {
  const result = extractFixture(
    "memory-this",
    jobSpec([
      { name: "start", impl: "src/job.ts#Job.start", from: "queued", to: "running" },
      { name: "finish", impl: "src/job.ts#Job.finish", from: "running", to: "done" },
    ]),
  );

  it("extracts this.status writes, but not the constructor's initialization", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual(["finish", "start"]);
    expect(result.findings).toEqual([]);
  });

  it("narrows this.status and decides atomicity per method", () => {
    const start = transitionOf(result, "start");
    expect(start.from).toEqual(["queued"]);
    expect(atomicity(result, "start")).toEqual({ atomic: true, scope: "synchronous" });
    expect(start.sites?.invocation).toBeUndefined();
    expect(transitionOf(result, "finish").from).toEqual(["running"]);
    expect(atomicity(result, "finish")).toEqual({ atomic: false, scope: undefined });
  });
});

describe("memory: entity from a Map lookup", () => {
  const result = extractFixture(
    "memory-map",
    jobSpec([
      { name: "start", impl: "src/queue.ts#Queue.start", from: "queued", to: "running" },
      { name: "finish", impl: "src/queue.ts#Queue.finish", from: "running", to: "done" },
      { name: "fail", impl: "src/queue.ts#Queue.fail", from: "running", to: "failed" },
      { name: "startFirst", impl: "src/queue.ts#Queue.startFirst", from: "queued", to: "running" },
    ]),
  );

  it("narrows through the lookup's guard and is atomic", () => {
    for (const [name, from] of [
      ["start", "queued"],
      ["finish", "running"],
      ["fail", "running"],
    ] as const) {
      const t = transitionOf(result, name);
      expect(t.from).toEqual([from]);
      expect(t.atomic).toBe(true);
      expect(t.sites?.atomic?.kind).toBe("synchronous");
    }
    expect(result.findings).toEqual([]);
  });

  const inv = (n: string) => transitionOf(result, n).sites?.invocation;

  it("traces the lookup key to the impl's parameters as the entity id", () => {
    expect(inv("start")).toEqual({
      impl: { file: "src/queue.ts", symbol: "Queue.start" },
      entityId: { param: 0, path: [] },
    });
    expect(inv("finish")?.entityId).toEqual({ param: 0, path: ["jobId"] });
    expect(inv("fail")?.entityId).toEqual({ param: 0, path: [] });
  });

  it("leaves the invocation out when the key is not an argument", () => {
    expect(inv("startFirst")).toBeUndefined();
  });
});

describe("the same code under assign: no read through a bound client", () => {
  const asAssign = (atomic: boolean): BehaviorModel => {
    const spec = jobSpec(
      [{ name: "start", impl: "src/jobs.ts#startJob", from: "queued", to: "running" }],
      atomic,
    );
    spec.bindings.persistence = "assign";
    return spec;
  };

  it("warns that atomicity is undecidable when the spec says atomic, and gives no verdict", () => {
    const result = extractFixture("memory-sync", asAssign(true));
    // As specified (so conformance reports no `non-atomic`), with the reason.
    expect(transitionOf(result, "start").atomic).toBe(true);
    expect(transitionOf(result, "start").sites?.atomicUnknown).toContain("no read of");
    expect(result.findings.map((f) => [f.id, f.severity])).toEqual([
      ["unanalyzable:Jobs:read:start", "warning"],
    ]);
  });

  it("stays quiet when the spec does not ask for atomic", () => {
    const result = extractFixture("memory-sync", asAssign(false));
    expect(transitionOf(result, "start").atomic).toBe(false);
    expect(result.findings).toEqual([]);
  });
});
