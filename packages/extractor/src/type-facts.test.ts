import { afterAll, describe, expect, it } from "vitest";
import { openProject } from "../test/typescript";
import type { NarrowRequest } from "./type-facts";
import { findCandidateWrites, rebindWrites } from "./writes";

const SOURCE = `
type S = "a" | "b" | "c";
interface E { id: string; status: S }
declare function save(e: E): void;

export function ifThrow(x: E) { if (x.status !== "a") throw new Error("no"); x.status = "b"; }
export function viaSwitch(x: E) { switch (x.status) { case "b": x.status = "c"; break; } }
export function early(x: E) { if (x.status === "c") return; x.status = "c"; }
export function none(x: E) { x.status = "a"; }
export function spread(x: E) { if (x.status === "a") save({ ...x, status: "b" }); }
export function chain(x: E, y: E) { if (y.status === "b") x.status = y.status = "a"; }
export function deep(ctx: { order: E }) { if (ctx.order.status === "c") ctx.order.status = "a"; }
`;

function setup() {
  const project = openProject({ "cases.ts": SOURCE });
  const file = `${project.root}/cases.ts`;
  const original = project.files.find((f) => f.fileName === file);
  if (!original) throw new Error(`${file} is not in the program`);
  const fields = new Set(["status"]);
  const candidates = findCandidateWrites([original], fields);
  const facts = project.facts;
  const requests: NarrowRequest[] = candidates.map((c) => ({
    file: c.file,
    span: c.span,
    ref: c.ref as string,
    field: c.field,
  }));
  const handles = facts.planNarrowing(requests);
  return { project, facts, candidates, handles, original, file, fields };
}

describe("ProgramTypeFacts (probe-first)", () => {
  const { project, facts, candidates, handles, original, file, fields } = setup();
  afterAll(() => project.close());
  const answers = handles.map((h) => facts.narrowedLiteralsAt(h));
  const byRef = (i: number) => ({ ref: candidates[i]?.ref, ...answers[i] });

  it("finds every candidate write syntactically, outer before inner", () => {
    expect(candidates.map((c) => [c.kind, c.ref])).toEqual([
      ["assign", "x"],
      ["assign", "x"],
      ["assign", "x"],
      ["assign", "x"],
      ["spread", "x"],
      ["assign", "x"],
      ["assign", "y"],
      ["assign", "ctx.order"],
    ]);
  });

  it("reads the narrowed type just before each write", () => {
    expect(answers.map((a) => a.values)).toEqual([
      ["a"],
      ["b"],
      ["a", "b"],
      ["a", "b", "c"],
      ["a"],
      ["a", "b", "c"],
      ["b"],
      ["c"],
    ]);
  });

  it("flags the full declared union as unconstrained", () => {
    expect(byRef(3)).toMatchObject({ unconstrained: true, declared: ["a", "b", "c"] });
    expect(byRef(0)).toMatchObject({ unconstrained: false, typeText: '"a"', declaredText: "S" });
    expect(byRef(0).refTypeNames).toEqual(["E"]);
  });

  it("maps probed positions back to the original file, nested probes included", () => {
    const writes = rebindWrites(
      candidates,
      fields,
      (f) => facts.program.getSourceFile(f),
      (f, o) => facts.toOriginalPosition(f, o),
    );
    writes.forEach((w, i) => {
      const sf = w.expr.getSourceFile();
      expect(facts.toOriginalPosition(file, w.expr.getStart(sf))).toBe(candidates[i]?.span.start);
      expect(facts.toOriginalPosition(file, w.expr.getEnd())).toBe(candidates[i]?.span.end);
    });
    const probed = facts.program.getSourceFile(file)?.text ?? "";
    expect(probed).toContain('(x.status, x.status = (y.status, y.status = "a"))');
    expect(probed.split("\n").length).toBe(original.text.split("\n").length);
  });

  it("leaves the base program's source file unprobed", () => {
    expect(facts.program.getSourceFile(file)).not.toBe(original);
    expect(original.text).toBe(SOURCE);
  });

  it("refuses to plan after the first type query", () => {
    expect(() => facts.planNarrowing([])).toThrow(/after the first type query/);
  });
});
