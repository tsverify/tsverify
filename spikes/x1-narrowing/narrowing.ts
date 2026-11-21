// Spike X1: techniques for asking the TypeScript checker which states an entity can be in
// just before a write to its state field. Throwaway research code: see README.md.
//
// ts-morph is used only to load the tsconfig and to manage the program. Everything else
// walks raw `ts.Node`s: wrapping every node in ts-morph objects (forEachDescendant) costs
// more than type-checking at 25k lines, and forgetting those wrappers costs as much again.

import { fileURLToPath } from "node:url";
import { Project, type SourceFile, ts } from "ts-morph";

export { ts };

export const FIXTURE_TSCONFIG = fileURLToPath(new URL("./fixture/tsconfig.json", import.meta.url));

/** Sorted literal values, or "*" when the type is not a finite set of literals. */
export type FromSet = readonly string[] | "*";

export type TechniqueId = "naive" | "precedingRead" | "probe" | "symbolAtLocation" | "borrowedFlow";

export const TECHNIQUES: readonly { id: TechniqueId; label: string }[] = [
  { id: "naive", label: "T0 getTypeAtLocation(write target)" },
  { id: "precedingRead", label: "T1 nearest preceding read" },
  { id: "probe", label: "T2 probe injection" },
  { id: "symbolAtLocation", label: "T3 getTypeOfSymbolAtLocation" },
  { id: "borrowedFlow", label: "T4 synthetic ref + borrowed flowNode (internal)" },
];

/** A syntactic write to `<ref>.<field>` found inside a fixture case function. */
export interface WriteSite {
  /** Name of the enclosing `caseNN_*` / `limitNN_*` declaration. */
  caseId: string;
  kind: "assign" | "spread";
  field: string;
  sourceFile: ts.SourceFile;
  /** The entity expression: `order`, `o`, `this`. */
  ref: ts.Expression;
  /**
   * The expression a probe wraps: the assignment `x.status = v`, or the object literal
   * `{ ...x, status: v }`.
   */
  writeExpr: ts.Expression;
  /** Assignment only: the `x.status` target. */
  target?: ts.PropertyAccessExpression;
}

const CASE_NAME = /^(case|limit)\d+[a-z]?_/;

export function loadProject(tsConfigFilePath = FIXTURE_TSCONFIG): Project {
  return new Project({ tsConfigFilePath });
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  ts.forEachChild(node, (c) => {
    visit(c);
    forEachDescendant(c, visit);
  });
}

function isFieldAccess(n: ts.Node, field: string): n is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name) && n.name.text === field;
}

function isPlainAssignment(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** Purely syntactic. Never touches the checker, so it can run before probes are injected. */
export function findWriteSites(sourceFile: ts.SourceFile, field = "status"): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const decl of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(decl) && !ts.isClassDeclaration(decl)) continue;
    const caseId = decl.name?.text;
    if (caseId === undefined || !CASE_NAME.test(caseId)) continue;
    forEachDescendant(decl, (n) => {
      if (isPlainAssignment(n) && isFieldAccess(n.left, field)) {
        const target = n.left;
        sites.push({
          caseId,
          kind: "assign",
          field,
          sourceFile,
          ref: target.expression,
          writeExpr: n,
          target,
        });
      } else if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === field &&
        ts.isObjectLiteralExpression(n.parent)
      ) {
        const spread = n.parent.properties.find(ts.isSpreadAssignment);
        if (spread) {
          sites.push({
            caseId,
            kind: "spread",
            field,
            sourceFile,
            ref: spread.expression,
            writeExpr: n.parent,
          });
        }
      }
    });
  }
  return sites;
}

export function findAllWriteSites(project: Project, field = "status"): WriteSite[] {
  return project.getSourceFiles().flatMap((sf) => findWriteSites(sf.compilerNode, field));
}

const checkerOf = (project: Project): ts.TypeChecker => project.getTypeChecker().compilerObject;

// --- type -> literal set ---------------------------------------------------------------

export function literalsOf(type: ts.Type, checker: ts.TypeChecker): FromSet {
  const F = ts.TypeFlags;
  if (type.flags & (F.Any | F.Unknown)) return "*";
  if (type.flags & F.Never) return [];
  if (type.flags & (F.TypeParameter | F.IndexedAccess | F.Substitution)) {
    const c = checker.getBaseConstraintOfType(type);
    return c && c !== type ? literalsOf(c, checker) : "*";
  }
  if (type.isIntersection()) {
    // e.g. `T["status"] & "paid"`: intersect the members that are finite.
    let acc: Set<string> | undefined;
    for (const part of type.types) {
      const s = literalsOf(part, checker);
      if (s === "*") continue;
      acc = acc ? new Set(s.filter((v) => acc?.has(v))) : new Set(s);
    }
    return acc ? [...acc].sort() : "*";
  }
  const out = new Set<string>();
  for (const part of type.isUnion() ? type.types : [type]) {
    if (part.isStringLiteral() || part.isNumberLiteral()) out.add(String(part.value));
    else if (part.flags & F.BooleanLiteral) out.add(checker.typeToString(part));
    else if (part.flags & F.Undefined) out.add("undefined");
    else if (part.flags & F.Null) out.add("null");
    else if (part !== type && part.flags & (F.Intersection | F.Instantiable)) {
      const s = literalsOf(part, checker); // e.g. `T["status"] & "paid"` inside a union
      if (s === "*") return "*";
      for (const v of s) out.add(v);
    } else return "*"; // string, template literal, object, ...
  }
  return [...out].sort();
}

function propertyTypeOf(checker: ts.TypeChecker, objType: ts.Type, field: string): FromSet {
  const prop = checker.getPropertyOfType(checker.getApparentType(objType), field);
  return prop ? literalsOf(checker.getTypeOfSymbol(prop), checker) : "*";
}

/** The field's declared literal domain, used to decide "unconstrained". */
export function declaredDomain(project: Project, site: WriteSite): FromSet {
  const checker = checkerOf(project);
  if (site.target) {
    const sym = checker.getSymbolAtLocation(site.target.name);
    return sym ? literalsOf(checker.getTypeOfSymbol(sym), checker) : "*";
  }
  const refSym = checker.getSymbolAtLocation(site.ref);
  const refType = refSym ? checker.getTypeOfSymbol(refSym) : checker.getTypeAtLocation(site.ref);
  return propertyTypeOf(checker, refType, site.field);
}

// --- T0: naive ---------------------------------------------------------------------------

/** getTypeAtLocation on the assignment target; for spreads, the spread object's `status`. */
export function naive(project: Project, site: WriteSite): FromSet {
  const checker = checkerOf(project);
  if (site.target) return literalsOf(checker.getTypeAtLocation(site.target), checker);
  return propertyTypeOf(checker, checker.getTypeAtLocation(site.ref), site.field);
}

// --- T1: nearest preceding read -----------------------------------------------------------

export function findPrecedingRead(site: WriteSite): ts.PropertyAccessExpression | undefined {
  const sf = site.sourceFile;
  let fn: ts.Node | undefined = site.writeExpr.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return undefined;
  const refText = site.ref.getText(sf);
  const writeStart = site.writeExpr.getStart(sf);
  let best: ts.PropertyAccessExpression | undefined;
  forEachDescendant(fn, (n) => {
    if (!isFieldAccess(n, site.field) || n === site.target) return;
    if (n.expression.getText(sf) !== refText || n.getEnd() > writeStart) return;
    const p = n.parent;
    if (isPlainAssignment(p) && p.left === n) return;
    if (!best || n.getStart(sf) > best.getStart(sf)) best = n;
  });
  return best;
}

export function precedingRead(project: Project, site: WriteSite): FromSet {
  const read = findPrecedingRead(site);
  if (!read) return declaredDomain(project, site); // nothing to ask: fall back to declared
  const checker = checkerOf(project);
  return literalsOf(checker.getTypeAtLocation(read), checker);
}

// --- T3: getTypeOfSymbolAtLocation --------------------------------------------------------

/** Field symbol at the write's name node (assign) or at the spread reference (spread). */
export function symbolAtLocation(project: Project, site: WriteSite): FromSet {
  const checker = checkerOf(project);
  if (site.target) {
    const sym = checker.getSymbolAtLocation(site.target.name);
    if (!sym) return "*";
    return literalsOf(checker.getTypeOfSymbolAtLocation(sym, site.target.name), checker);
  }
  const refType = checker.getTypeAtLocation(site.ref);
  const prop = checker.getPropertyOfType(checker.getApparentType(refType), site.field);
  if (!prop) return "*";
  return literalsOf(checker.getTypeOfSymbolAtLocation(prop, site.ref), checker);
}

// --- T4: synthetic reference with a borrowed flow node (uses TS internals) -----------------

type Mutable = { parent?: ts.Node; flowNode?: unknown; flags: number; pos: number; end: number };

function cloneRef(expr: ts.Expression): ts.Expression | undefined {
  const f = ts.factory;
  if (ts.isIdentifier(expr)) return f.createIdentifier(expr.text);
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return f.createThis();
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const inner = cloneRef(expr.expression);
    return inner && f.createPropertyAccessExpression(inner, expr.name.text);
  }
  return undefined;
}

/**
 * Builds a detached `ref.field` read, pretends it is a parse-tree node located at `anchor`,
 * and gives it `anchor.flowNode` so the checker runs flow analysis from that point.
 * Relies on the internal `flowNode` property and on clearing `NodeFlags.Synthesized`.
 */
export function borrowedFlow(project: Project, site: WriteSite): FromSet {
  const checker = checkerOf(project);
  const anchor: ts.Node = site.target ?? site.ref;
  const flowNode = (anchor as unknown as Mutable).flowNode;
  const inner = cloneRef(site.ref);
  if (!flowNode || !inner) return "*";
  const probe = ts.factory.createPropertyAccessExpression(inner, site.field);
  const adopt = (n: ts.Node, parent: ts.Node) => {
    const m = n as unknown as Mutable;
    m.flags &= ~ts.NodeFlags.Synthesized;
    m.parent = parent;
    m.pos = anchor.pos;
    m.end = anchor.end;
    if (
      ts.isIdentifier(n) ||
      ts.isPropertyAccessExpression(n) ||
      n.kind === ts.SyntaxKind.ThisKeyword
    ) {
      m.flowNode = flowNode;
    }
    ts.forEachChild(n, (c) => {
      adopt(c, n);
    });
  };
  adopt(probe, anchor.parent);
  return literalsOf(checker.getTypeAtLocation(probe), checker);
}

// --- T2: probe injection ------------------------------------------------------------------

/** Text of the probe read for a site, e.g. `order.status`. */
export function probeText(site: WriteSite): string {
  return `${site.ref.getText(site.sourceFile)}.${site.field}`;
}

/**
 * Wraps each write expression `W` in `(ref.field, W)`. The comma operator creates no flow
 * nodes, so the probe read sees exactly the flow state just before `W`. No newline is
 * inserted, so line numbers are preserved.
 */
export function injectProbes(text: string, sites: readonly WriteSite[]): string {
  const start = (s: WriteSite) => s.writeExpr.getStart(s.sourceFile);
  const sorted = [...sites].sort((a, b) => start(b) - start(a));
  let out = text;
  for (const s of sorted) {
    const [from, to] = [start(s), s.writeExpr.getEnd()];
    out = `${out.slice(0, from)}(${probeText(s)}, ${out.slice(from, to)})${out.slice(to)}`;
  }
  return out;
}

/** In a probed file the write's parent is `(probe, W)`; returns the probe read. */
export function probeOf(site: WriteSite): ts.PropertyAccessExpression | undefined {
  const comma = site.writeExpr.parent;
  if (!ts.isBinaryExpression(comma) || comma.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
    return undefined;
  }
  return isFieldAccess(comma.left, site.field) ? comma.left : undefined;
}

export function probeType(project: Project, site: WriteSite): ts.Type {
  const probe = probeOf(site);
  if (!probe) throw new Error(`no probe found for ${site.caseId}`);
  return checkerOf(project).getTypeAtLocation(probe);
}

export function probeAnswer(project: Project, site: WriteSite): FromSet {
  return literalsOf(probeType(project, site), checkerOf(project));
}

/**
 * "Probe-first": inject probes into every file with candidate write sites BEFORE the first
 * checker query, so the probed program is the only program ever checked (no re-check).
 * Returns the sites re-found in the probed files.
 */
export function probeFirst(project: Project, field = "status"): WriteSite[] {
  const out: WriteSite[] = [];
  for (const sf of project.getSourceFiles()) {
    const sites = findWriteSites(sf.compilerNode, field);
    if (sites.length === 0) continue;
    const text = injectProbes(sf.getFullText(), sites);
    const probed = project.createSourceFile(sf.getFilePath(), text, { overwrite: true });
    out.push(...findWriteSites(probed.compilerNode, field));
  }
  return out;
}

/**
 * "Post-hoc": the original program has already been checked. Add probed copies of the
 * affected files next to the originals (the originals and their nodes stay valid), query,
 * then remove the copies. Every call costs one program rebuild plus a fresh, lazy checker.
 */
export function probePostHoc(
  project: Project,
  sites: readonly WriteSite[],
): Map<WriteSite, FromSet> {
  const byFile = new Map<ts.SourceFile, WriteSite[]>();
  for (const s of sites) byFile.set(s.sourceFile, [...(byFile.get(s.sourceFile) ?? []), s]);
  const copies: SourceFile[] = [];
  const pairs: [WriteSite, WriteSite][] = [];
  for (const [sf, fileSites] of byFile) {
    const copyPath = sf.fileName.replace(/\.ts$/, ".__probe__.ts");
    const copy = project.createSourceFile(copyPath, injectProbes(sf.getFullText(), fileSites), {
      overwrite: true,
    });
    copies.push(copy);
    // findWriteSites is deterministic, so the k-th write in the copy is the k-th original.
    const all = findWriteSites(sf, fileSites[0]?.field);
    const copied = findWriteSites(copy.compilerNode, fileSites[0]?.field);
    for (const s of fileSites) {
      const twin = copied[all.findIndex((a) => a.writeExpr === s.writeExpr)];
      if (!twin) throw new Error(`probe copy lost ${s.caseId}`);
      pairs.push([s, twin]);
    }
  }
  const result = new Map<WriteSite, FromSet>();
  for (const [site, twin] of pairs) result.set(site, probeAnswer(project, twin));
  for (const c of copies) project.removeSourceFile(c);
  return result;
}

// --- shared --------------------------------------------------------------------------------

export function run(project: Project, technique: Exclude<TechniqueId, "probe">, site: WriteSite) {
  switch (technique) {
    case "naive":
      return naive(project, site);
    case "precedingRead":
      return precedingRead(project, site);
    case "symbolAtLocation":
      return symbolAtLocation(project, site);
    case "borrowedFlow":
      return borrowedFlow(project, site);
  }
}

export function sameSet(a: FromSet, b: FromSet): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** "ALL" when the answer equals the declared domain (the extractor's "unconstrained"). */
export function renderSet(set: FromSet, domain: FromSet): string {
  if (set === "*") return "*";
  if (domain !== "*" && set.length > 1 && sameSet(set, domain)) return "ALL";
  return set.length === 0 ? "{} (unreachable)" : `{${set.join(",")}}`;
}
