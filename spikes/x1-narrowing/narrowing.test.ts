import type { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";
import { LIMITS, REQUIRED } from "./cases.ts";
import {
  type FromSet,
  findAllWriteSites,
  loadProject,
  probeAnswer,
  probeFirst,
  probePostHoc,
  ts,
} from "./narrowing.ts";
import { runTs7 } from "./ts7.ts";

// Recommended technique: probe injection, probe-first (inject before the first check).
describe("X1 probe injection (probe-first)", () => {
  let project: Project;
  let answers: Map<string, FromSet>;

  beforeAll(() => {
    project = loadProject();
    const sites = probeFirst(project);
    answers = new Map(sites.map((s) => [s.caseId, probeAnswer(project, s)]));
  });

  it("uses the TypeScript version ts-morph 28 bundles", () => {
    expect(ts.version).toBe("6.0.2");
  });

  it("finds exactly one write per fixture case", () => {
    const ids = [...REQUIRED, ...LIMITS].map((e) => e.caseId).sort();
    expect([...answers.keys()].sort()).toEqual(ids);
  });

  it.each(REQUIRED)("required: $title", ({ caseId, expected }) => {
    expect(answers.get(caseId)).toEqual(expected);
  });

  it.each(LIMITS)("limit: $title", ({ caseId, expected }) => {
    expect(answers.get(caseId)).toEqual(expected);
  });

  it("probes add no diagnostics to the program", () => {
    expect(project.getPreEmitDiagnostics()).toHaveLength(0);
  });
});

describe("X1 probe injection on TypeScript 7 (tsgo sync API)", () => {
  it("gives the same answers as TS 6 for every case", () => {
    const { answers, overlayReads, overlayCount } = runTs7(0);
    expect(overlayReads).toBe(overlayCount); // the probed texts really were served
    for (const e of [...REQUIRED, ...LIMITS]) expect(answers.get(e.caseId)).toEqual(e.expected);
  });
});

describe("X1 probe injection (post-hoc, on an already-checked program)", () => {
  let project: Project;

  beforeAll(() => {
    project = loadProject();
    expect(project.getPreEmitDiagnostics()).toHaveLength(0); // checks the program first
  });

  it("agrees with probe-first and leaves the project unchanged", () => {
    const sites = findAllWriteSites(project);
    const got = probePostHoc(project, sites);
    const byCase = new Map([...got].map(([site, set]) => [site.caseId, set]));
    for (const e of [...REQUIRED, ...LIMITS]) expect(byCase.get(e.caseId)).toEqual(e.expected);
    expect(project.getSourceFiles().map((f) => f.getBaseName())).not.toContain(
      "cases.__probe__.ts",
    );
  });
});
