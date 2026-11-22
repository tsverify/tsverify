/**
 * Type facts the extractor needs from the TypeScript checker, behind a seam so a TS 7 (tsgo)
 * backend can replace the ts-morph (TS 6) one later (doc 5, spike X1).
 *
 * Narrowing uses X1's **probe-first injection**: every candidate state write `W` is rewritten to
 * `(ref.field, W)` in the in-memory project *before* the first type query. The comma operator
 * creates no flow node, so the probe read sees exactly the flow state just before `W`. No newline
 * is inserted, so lines never change and only columns on probed lines shift; `toOriginalPosition`
 * maps them back.
 */
import { type Project, ts } from "ts-morph";

/** Sorted literal values, or `"*"` when the type is not a finite literal set (`string`, `any`, …). */
export type LiteralSet = readonly string[] | "*";

export interface NarrowRequest {
  /** Absolute file path, as the project knows it. */
  file: string;
  /** Original-file offsets of the expression the probe wraps (`x.status = v`, `{ ...x, status: v }`). */
  span: { start: number; end: number };
  /** Side-effect-free reference valid at that point: `order`, `this`, `ctx.order`. */
  ref: string;
  field: string;
}

export interface Narrowed {
  /** Literals the field can hold just before the write (`[]` = the write is unreachable). */
  values: LiteralSet;
  /** The field's declared literal domain on the reference's declared type. */
  declared: LiteralSet;
  /** true when `values` equals a finite `declared` domain: nothing narrows the write. */
  unconstrained: boolean;
  /** Raw narrowed type text, for diagnostics (`"paid" | "shipped"`, `string`). */
  typeText: string;
  /** Raw declared field type text (`OrderStatus`, `string`). */
  declaredText: string;
  /** Names of the reference's declared type: alias, symbol, union/intersection members. */
  refTypeNames: readonly string[];
}

export type NarrowHandle = number & { readonly __brand: "NarrowHandle" };

export interface TypeFacts {
  /**
   * Phase 1, syntax only. Must be called once, before the first type query: the backend injects
   * every probe into its overlay so the program is checked exactly once.
   */
  planNarrowing(requests: readonly NarrowRequest[]): readonly NarrowHandle[];
  /** Phase 2: the narrowed literal set at a planned site. */
  narrowedLiteralsAt(handle: NarrowHandle): Narrowed;
  /** Overlay (probed) offset → original-file offset. Lines never change. */
  toOriginalPosition(file: string, overlayOffset: number): number;
}

// --- type → literal set ------------------------------------------------------------------

export function literalsOf(type: ts.Type, checker: ts.TypeChecker): LiteralSet {
  const F = ts.TypeFlags;
  if (type.flags & (F.Any | F.Unknown)) return "*";
  if (type.flags & F.Never) return [];
  if (type.flags & (F.TypeParameter | F.IndexedAccess | F.Substitution)) {
    const c = checker.getBaseConstraintOfType(type);
    return c && c !== type ? literalsOf(c, checker) : "*";
  }
  if (type.isIntersection()) {
    let acc: Set<string> | undefined;
    for (const part of type.types) {
      const s = literalsOf(part, checker);
      if (s === "*") continue;
      const prev: Set<string> | undefined = acc;
      acc = prev ? new Set(s.filter((v) => prev.has(v))) : new Set(s);
    }
    return acc ? [...acc].sort() : "*";
  }
  const out = new Set<string>();
  for (const part of type.isUnion() ? type.types : [type]) {
    if (part.isStringLiteral() || part.isNumberLiteral()) out.add(String(part.value));
    else if (part.flags & F.BooleanLiteral) out.add(checker.typeToString(part));
    else if (part.flags & (F.Undefined | F.Null | F.Void)) continue;
    else if (part !== type && part.flags & (F.Intersection | F.Instantiable)) {
      const s = literalsOf(part, checker);
      if (s === "*") return "*";
      for (const v of s) out.add(v);
    } else return "*";
  }
  return [...out].sort();
}

/** A single string/number/boolean literal value of an expression's type, if it has exactly one. */
export function singleLiteralOf(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  if (type.isUnion()) return undefined;
  const s = literalsOf(type, checker);
  return s !== "*" && s.length === 1 ? s[0] : undefined;
}

/** Utility aliases whose first argument names the type (`Pick<Order, "status">` answers to `Order`). */
const TRANSPARENT_ALIASES: ReadonlySet<string> = new Set([
  "Readonly",
  "Required",
  "Partial",
  "NonNullable",
  "Pick",
  "Omit",
]);

/** Names a type node refers to: `Row` → `Row` plus what `Row` aliases; `Pick<Order, …>` → `Order`. */
function typeNodeNames(node: ts.TypeNode, checker: ts.TypeChecker, depth: number): string[] {
  if (depth > 4) return [];
  if (ts.isParenthesizedTypeNode(node)) return typeNodeNames(node.type, checker, depth + 1);
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
    const first = node.typeArguments?.[0];
    if (TRANSPARENT_ALIASES.has(name) && first) return typeNodeNames(first, checker, depth + 1);
  }
  return typeNames(checker.getTypeFromTypeNode(node), checker, depth + 1);
}

/**
 * Names a type answers to: its alias, its symbol, union/intersection members, base constraints,
 * the first argument of a transparent utility alias, and what a user alias stands for
 * (`type Shipment = Row; type Row = Pick<Order, …>` answers to `Order`).
 */
export function typeNames(type: ts.Type, checker: ts.TypeChecker, depth = 0): string[] {
  if (depth > 4) return [];
  const names = new Set<string>();
  const alias = type.aliasSymbol;
  if (alias) {
    names.add(alias.name);
    const first = type.aliasTypeArguments?.[0];
    if (TRANSPARENT_ALIASES.has(alias.name) && first) {
      for (const n of typeNames(first, checker, depth + 1)) names.add(n);
    } else {
      for (const d of alias.declarations ?? []) {
        if (!ts.isTypeAliasDeclaration(d)) continue;
        for (const n of typeNodeNames(d.type, checker, depth + 1)) names.add(n);
      }
    }
  }
  const sym = type.getSymbol();
  if (sym && !sym.name.startsWith("__")) names.add(sym.name);
  if (type.isUnionOrIntersection()) {
    for (const part of type.types)
      for (const n of typeNames(part, checker, depth + 1)) names.add(n);
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const c = checker.getBaseConstraintOfType(type);
    if (c && c !== type) for (const n of typeNames(c, checker, depth + 1)) names.add(n);
  }
  return [...names].sort();
}

/** The declared (not flow-narrowed) type of a reference expression. */
export function declaredTypeOfRef(ref: ts.Expression, checker: ts.TypeChecker): ts.Type {
  const target = ts.isPropertyAccessExpression(ref) ? ref.name : ref;
  const sym =
    ref.kind === ts.SyntaxKind.ThisKeyword ? undefined : checker.getSymbolAtLocation(target);
  const type = sym ? checker.getTypeOfSymbol(sym) : checker.getTypeAtLocation(ref);
  return checker.getNonNullableType(type);
}

/** The declared type of `field` on a reference's declared type, if it has that property. */
export function declaredFieldType(
  ref: ts.Expression,
  field: string,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const refType = declaredTypeOfRef(ref, checker);
  const prop = checker.getPropertyOfType(checker.getApparentType(refType), field);
  return prop ? checker.getTypeOfSymbol(prop) : undefined;
}

export function sameSet(a: LiteralSet, b: LiteralSet): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- ts-morph implementation --------------------------------------------------------------

interface Insertion {
  /** Original offset the text is inserted at. */
  at: number;
  text: string;
}

interface Planned {
  request: NarrowRequest;
  /** Overlay offset of the probe's `ref.field` expression. */
  probeStart: number;
  probeEnd: number;
  answer?: Narrowed;
}

/** Finds the node exactly covering `[start, end)` (smallest such node). */
function nodeAtSpan(sf: ts.SourceFile, start: number, end: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= start && n.getEnd() >= end) {
      if (n.getStart(sf) === start && n.getEnd() === end) found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

export class TsMorphTypeFacts implements TypeFacts {
  private readonly planned: Planned[] = [];
  private readonly insertions = new Map<string, Insertion[]>();
  private queried = false;

  constructor(private readonly project: Project) {}

  get checker(): ts.TypeChecker {
    this.queried = true;
    return this.project.getTypeChecker().compilerObject;
  }

  get program(): ts.Program {
    this.queried = true;
    return this.project.getProgram().compilerObject;
  }

  planNarrowing(requests: readonly NarrowRequest[]): readonly NarrowHandle[] {
    if (this.queried) throw new Error("extractor: planNarrowing after the first type query");
    const byFile = new Map<string, number[]>();
    const handles: NarrowHandle[] = [];
    for (const request of requests) {
      const index = this.planned.length;
      this.planned.push({ request, probeStart: -1, probeEnd: -1 });
      handles.push(index as NarrowHandle);
      const list = byFile.get(request.file) ?? [];
      list.push(index);
      byFile.set(request.file, list);
    }
    for (const [file, indices] of byFile) {
      if (this.insertions.has(file)) throw new Error(`extractor: ${file} probed twice`);
      const sf = this.project.getSourceFileOrThrow(file);
      const text = sf.getFullText();
      // Opens sort by start, outer (longer) first; closes come before opens at the same offset
      // and inner (shorter) first, so nested spans stay well-formed.
      type Edit = { at: number; open: boolean; len: number; planned: number };
      const edits: Edit[] = [];
      for (const i of indices) {
        const { span } = (this.planned[i] as Planned).request;
        const len = span.end - span.start;
        edits.push({ at: span.start, open: true, len, planned: i });
        edits.push({ at: span.end, open: false, len, planned: i });
      }
      edits.sort((a, b) => {
        if (a.at !== b.at) return a.at - b.at;
        if (a.open !== b.open) return a.open ? 1 : -1;
        return a.open ? b.len - a.len : a.len - b.len;
      });
      let out = "";
      let last = 0;
      const inserts: Insertion[] = [];
      for (const e of edits) {
        out += text.slice(last, e.at);
        last = e.at;
        const p = this.planned[e.planned] as Planned;
        if (e.open) {
          const probe = `${p.request.ref}.${p.request.field}`;
          p.probeStart = out.length + 1;
          p.probeEnd = p.probeStart + probe.length;
          const ins = `(${probe}, `;
          out += ins;
          inserts.push({ at: e.at, text: ins });
        } else {
          out += ")";
          inserts.push({ at: e.at, text: ")" });
        }
      }
      out += text.slice(last);
      this.insertions.set(file, inserts);
      this.project.createSourceFile(file, out, { overwrite: true });
    }
    return handles;
  }

  narrowedLiteralsAt(handle: NarrowHandle): Narrowed {
    const p = this.planned[handle];
    if (!p) throw new Error(`extractor: unknown narrow handle ${handle}`);
    if (p.answer) return p.answer;
    const checker = this.checker;
    const sf = this.program.getSourceFile(p.request.file);
    const probe = sf && nodeAtSpan(sf, p.probeStart, p.probeEnd);
    if (!probe || !ts.isPropertyAccessExpression(probe)) {
      throw new Error(`extractor: probe not found in ${p.request.file} at ${p.probeStart}`);
    }
    const type = checker.getTypeAtLocation(probe);
    const fieldType = declaredFieldType(probe.expression, p.request.field, checker);
    const values = literalsOf(type, checker);
    const declared = fieldType ? literalsOf(fieldType, checker) : "*";
    p.answer = {
      values,
      declared,
      unconstrained: declared !== "*" && values !== "*" && sameSet(values, declared),
      typeText: checker.typeToString(type),
      declaredText: fieldType ? checker.typeToString(fieldType) : "unknown",
      refTypeNames: typeNames(declaredTypeOfRef(probe.expression, checker), checker),
    };
    return p.answer;
  }

  toOriginalPosition(file: string, overlayOffset: number): number {
    const inserts = this.insertions.get(file);
    if (!inserts) return overlayOffset;
    let shift = 0;
    for (const ins of inserts) {
      const overlayStart = ins.at + shift;
      if (overlayOffset < overlayStart) break;
      if (overlayOffset < overlayStart + ins.text.length) return ins.at;
      shift += ins.text.length;
    }
    return overlayOffset - shift;
  }
}
