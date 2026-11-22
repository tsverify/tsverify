import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { type NarrowRequest, TsMorphTypeFacts } from "./type-facts";
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
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"] },
  });
  const file = project.createSourceFile("/app/cases.ts", SOURCE).getFilePath();
  const original = project.getSourceFileOrThrow(file).compilerNode;
  const fields = new Set(["status"]);
  const candidates = findCandidateWrites([original], fields);
  const facts = new TsMorphTypeFacts(project);
  const requests: NarrowRequest[] = candidates.map((c) => ({
    file: c.file,
    span: c.span,
    ref: c.ref as string,
    field: c.field,
  }));
  const handles = facts.planNarrowing(requests);
  return { project, facts, candidates, handles, original, file, fields };
}

describe("TsMorphTypeFacts (probe-first)", () => {
  const { facts, candidates, handles, original, file, fields, project } = setup();
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
      (f) => project.getProgram().compilerObject.getSourceFile(f),
      (f, o) => facts.toOriginalPosition(f, o),
    );
    writes.forEach((w, i) => {
      const sf = w.expr.getSourceFile();
      expect(facts.toOriginalPosition(file, w.expr.getStart(sf))).toBe(candidates[i]?.span.start);
      expect(facts.toOriginalPosition(file, w.expr.getEnd())).toBe(candidates[i]?.span.end);
    });
    const probed = project.getSourceFileOrThrow(file).getFullText();
    expect(probed).toContain('(x.status, x.status = (y.status, y.status = "a"))');
    expect(probed.split("\n").length).toBe(original.text.split("\n").length);
  });

  it("refuses to plan after the first type query", () => {
    expect(() => facts.planNarrowing([])).toThrow(/after the first type query/);
  });
});
