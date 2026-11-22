/**
 * Type facts the extractor needs from the TypeScript checker, behind a seam so a TS 7 (tsgo)
 * backend can replace the classic compiler API one (TS 5.4–6.x, `typescript.ts`) later (spike X1).
 *
 * Narrowing uses X1's **probe-first injection**: every candidate state write `W` is rewritten to
 * `(ref.field, W)` in an in-memory overlay of the program *before* the first type query. The comma operator
 * creates no flow node, so the probe read sees exactly the flow state just before `W`. No newline
 * is inserted, so lines never change and only columns on probed lines shift; `toOriginalPosition`
 * maps them back.
 */
import type * as TS from "@typescript/typescript6";
import { ts } from "./typescript";

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

export function literalsOf(type: TS.Type, checker: TS.TypeChecker): LiteralSet {
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
export function singleLiteralOf(type: TS.Type, checker: TS.TypeChecker): string | undefined {
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
function typeNodeNames(node: TS.TypeNode, checker: TS.TypeChecker, depth: number): string[] {
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
export function typeNames(type: TS.Type, checker: TS.TypeChecker, depth = 0): string[] {
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
export function declaredTypeOfRef(ref: TS.Expression, checker: TS.TypeChecker): TS.Type {
  const target = ts.isPropertyAccessExpression(ref) ? ref.name : ref;
  const sym =
    ref.kind === ts.SyntaxKind.ThisKeyword ? undefined : checker.getSymbolAtLocation(target);
  const type = sym ? checker.getTypeOfSymbol(sym) : checker.getTypeAtLocation(ref);
  return checker.getNonNullableType(type);
}

/** The declared type of `field` on a reference's declared type, if it has that property. */
export function declaredFieldType(
  ref: TS.Expression,
  field: string,
  checker: TS.TypeChecker,
): TS.Type | undefined {
  const refType = declaredTypeOfRef(ref, checker);
  const prop = checker.getPropertyOfType(checker.getApparentType(refType), field);
  return prop ? checker.getTypeOfSymbol(prop) : undefined;
}

export function sameSet(a: LiteralSet, b: LiteralSet): boolean {
  if (a === "*" || b === "*") return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- membership guards (X1 L9: TS does not narrow through `.includes` / `.has`) -----------

/** Allowed field values (`undefined`: no information). */
type Allowed = ReadonlySet<string> | undefined;

function intersect(a: Allowed, b: Allowed): Allowed {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter((v) => b.has(v)));
}

function union(a: Allowed, b: Allowed): Allowed {
  return a && b ? new Set([...a, ...b]) : undefined;
}

function stripExpr(e: TS.Expression): TS.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** `a`, `this`, `a.b`, also through `?.` and `!`: canonical text, else undefined. */
function refText(e: TS.Expression): string | undefined {
  const x = stripExpr(e);
  if (ts.isIdentifier(x)) return x.text;
  if (x.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.name)) {
    const inner = refText(x.expression);
    return inner === undefined ? undefined : `${inner}.${x.name.text}`;
  }
  return undefined;
}

/** The `const` initializer an identifier stands for (through imports), if it has one. */
function constInitializer(id: TS.Identifier, checker: TS.TypeChecker): TS.Expression | undefined {
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  return decl.initializer;
}

/** The string literals of an array literal (all elements must be literals). */
function arrayLiterals(
  e: TS.Expression,
  checker: TS.TypeChecker,
  depth: number,
): string[] | undefined {
  const x = stripExpr(e);
  if (ts.isIdentifier(x) && depth < 4) {
    const init = constInitializer(x, checker);
    return init && arrayLiterals(init, checker, depth + 1);
  }
  if (!ts.isArrayLiteralExpression(x)) return undefined;
  const out: string[] = [];
  for (const el of x.elements) {
    if (!ts.isStringLiteral(el) && !ts.isNoSubstitutionTemplateLiteral(el)) return undefined;
    out.push(el.text);
  }
  return out;
}

/** The literals of `new Set([...])` (or a `const` bound to one). */
function setLiterals(
  e: TS.Expression,
  checker: TS.TypeChecker,
  depth: number,
): string[] | undefined {
  const x = stripExpr(e);
  if (ts.isIdentifier(x) && depth < 4) {
    const init = constInitializer(x, checker);
    return init && setLiterals(init, checker, depth + 1);
  }
  if (!ts.isNewExpression(x) || !ts.isIdentifier(x.expression) || x.expression.text !== "Set") {
    return undefined;
  }
  const arg = x.arguments?.[0];
  return x.arguments?.length === 1 && arg ? arrayLiterals(arg, checker, depth + 1) : undefined;
}

interface MembershipTarget {
  /** Canonical text of the entity reference (`order`, `this`, `ctx.order`). */
  ref: string;
  field: string;
  /** The field's finite domain, needed to read a negative test (`!L.includes(x)`); else undefined. */
  domain: readonly string[] | undefined;
  checker: TS.TypeChecker;
}

/**
 * Values `cond` allows for the field when it evaluates to `holds`. Only membership tests decide
 * anything (`L.includes(ref.field)` for a literal array `L`, `S.has(ref.field)` for a literal
 * `Set`); `!`, `&&` and `||` combine them; any other operand gives no information.
 */
function allowedBy(cond: TS.Expression, holds: boolean, t: MembershipTarget): Allowed {
  const e = stripExpr(cond);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return allowedBy(e.operand, !holds, t);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
    if (and || op === ts.SyntaxKind.BarBarToken) {
      const l = allowedBy(e.left, holds, t);
      const r = allowedBy(e.right, holds, t);
      // a && b holds / a || b fails: both sides do. Otherwise either side may.
      return and === holds ? intersect(l, r) : union(l, r);
    }
    return undefined;
  }
  if (!ts.isCallExpression(e) || e.arguments.length !== 1) return undefined;
  const callee = stripExpr(e.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return undefined;
  const arg = stripExpr(e.arguments[0] as TS.Expression);
  if (
    !ts.isPropertyAccessExpression(arg) ||
    !ts.isIdentifier(arg.name) ||
    arg.name.text !== t.field ||
    refText(arg.expression) !== t.ref
  ) {
    return undefined;
  }
  const method = callee.name.text;
  const list =
    method === "includes"
      ? arrayLiterals(callee.expression, t.checker, 0)
      : method === "has"
        ? setLiterals(callee.expression, t.checker, 0)
        : undefined;
  if (!list) return undefined;
  if (holds) return new Set(list);
  return t.domain ? new Set(t.domain.filter((v) => !list.includes(v))) : undefined;
}

/** A statement after which the rest of its block does not run (`throw`, `return`, …). */
function alwaysExits(st: TS.Statement): boolean {
  if (
    ts.isThrowStatement(st) ||
    ts.isReturnStatement(st) ||
    ts.isBreakStatement(st) ||
    ts.isContinueStatement(st)
  ) {
    return true;
  }
  if (ts.isBlock(st)) return st.statements.some(alwaysExits);
  if (ts.isIfStatement(st)) {
    return (
      st.elseStatement !== undefined &&
      alwaysExits(st.thenStatement) &&
      alwaysExits(st.elseStatement)
    );
  }
  return false;
}

function blockStatements(n: TS.Node): readonly TS.Statement[] | undefined {
  if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) return n.statements;
  if (ts.isCaseClause(n) || ts.isDefaultClause(n)) return n.statements;
  return undefined;
}

/**
 * The field values membership guards allow at `at`, read syntactically from the statements that
 * enclose it in its function (TS's own narrowing ignores them):
 * - `if (cond) { …at… } else { … }`: `cond` holds (or fails, in the `else` branch);
 * - an earlier `if (cond) throw | return | continue | break;` in an enclosing block: `cond` fails
 *   after it (and holds after `if (cond) { … } else return;`);
 * - `cond && …at…` and `cond ? …at… : …`.
 * Undefined when no membership guard applies.
 */
export function membershipAllowed(
  at: TS.Node,
  t: MembershipTarget,
): ReadonlySet<string> | undefined {
  let allowed: Allowed;
  for (let node = at; node.parent && !ts.isFunctionLike(node); node = node.parent) {
    const parent = node.parent;
    if (ts.isIfStatement(parent) && node !== parent.expression) {
      allowed = intersect(allowed, allowedBy(parent.expression, node === parent.thenStatement, t));
    } else if (ts.isConditionalExpression(parent) && node !== parent.condition) {
      allowed = intersect(allowed, allowedBy(parent.condition, node === parent.whenTrue, t));
    } else if (
      ts.isBinaryExpression(parent) &&
      node === parent.right &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      allowed = intersect(allowed, allowedBy(parent.left, true, t));
    } else {
      const statements = blockStatements(parent);
      for (const st of statements ?? []) {
        if (st === node) break;
        if (!ts.isIfStatement(st)) continue;
        const thenExits = alwaysExits(st.thenStatement);
        const elseExits = st.elseStatement !== undefined && alwaysExits(st.elseStatement);
        if (thenExits !== elseExits)
          allowed = intersect(allowed, allowedBy(st.expression, elseExits, t));
      }
    }
  }
  return allowed;
}

/**
 * `n` refined by the membership guards on the write's path (`membershipAllowed`): the narrowed
 * values (or, for a `string` field, nothing yet) intersected with what the guards allow.
 */
export function withMembershipGuards(
  n: Narrowed,
  at: TS.Node,
  ref: TS.Expression,
  field: string,
  checker: TS.TypeChecker,
): Narrowed {
  const text = refText(ref);
  if (text === undefined) return n;
  const base = n.values !== "*" ? n.values : n.declared !== "*" ? n.declared : undefined;
  const allowed = membershipAllowed(at, { ref: text, field, domain: base, checker });
  if (!allowed) return n;
  const values = (base ? base.filter((v) => allowed.has(v)) : [...allowed]).sort();
  return {
    ...n,
    values,
    unconstrained: n.declared !== "*" && sameSet(values, n.declared),
    typeText: values.length === 0 ? "never" : values.map((v) => JSON.stringify(v)).join(" | "),
  };
}

// --- classic compiler API implementation -------------------------------------------------

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
function nodeAtSpan(sf: TS.SourceFile, start: number, end: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (n: TS.Node): void => {
    if (n.getStart(sf) <= start && n.getEnd() >= end) {
      if (n.getStart(sf) === start && n.getEnd() === end) found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * A compiler host over the real file system (plus optional in-memory `files`) that serves the
 * probed `overlay` text in place of a file's own, and hands out one `SourceFile` per file and text,
 * so the probed program reuses every unprobed file of the base program as is.
 */
export interface OverlayHost extends TS.CompilerHost {
  /** Probed text by file name, filled by `planNarrowing` before the probed program exists. */
  readonly overlay: Map<string, string>;
}

export function createOverlayHost(
  options: TS.CompilerOptions,
  files: ReadonlyMap<string, string> = new Map(),
): OverlayHost {
  const overlay = new Map<string, string>();
  const parsed = new Map<string, TS.SourceFile>();
  const probed = new Map<string, TS.SourceFile>();
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  // The default getSourceFile reads through `host.readFile`, so the overlay reaches it too.
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);
  host.readFile = (name) => overlay.get(name) ?? files.get(name) ?? readFile.call(host, name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNew) => {
    const cache = overlay.has(name) ? probed : parsed;
    let sf = cache.get(name);
    if (sf === undefined) {
      sf = getSourceFile.call(host, name, languageVersion, onError, shouldCreateNew);
      if (sf !== undefined) cache.set(name, sf);
    }
    return sf;
  };
  return Object.assign(host, { overlay });
}

/**
 * `TypeFacts` over a classic `ts.Program`. `base` is the unprobed program, used for syntax only;
 * the probed program is created from it (reusing its unprobed files and module resolutions) with
 * `host`'s overlay on the first type query.
 */
export class ProgramTypeFacts implements TypeFacts {
  private readonly planned: Planned[] = [];
  private readonly insertions = new Map<string, Insertion[]>();
  private probed: TS.Program | undefined;

  constructor(
    private readonly base: TS.Program,
    private readonly host: OverlayHost,
  ) {}

  get checker(): TS.TypeChecker {
    return this.program.getTypeChecker();
  }

  get program(): TS.Program {
    this.probed ??=
      this.host.overlay.size === 0
        ? this.base
        : ts.createProgram({
            rootNames: this.base.getRootFileNames(),
            options: this.base.getCompilerOptions(),
            host: this.host,
            oldProgram: this.base,
            configFileParsingDiagnostics: this.base.getConfigFileParsingDiagnostics(),
          });
    return this.probed;
  }

  planNarrowing(requests: readonly NarrowRequest[]): readonly NarrowHandle[] {
    if (this.probed) throw new Error("extractor: planNarrowing after the first type query");
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
      const sf = this.base.getSourceFile(file);
      if (sf === undefined) throw new Error(`extractor: ${file} is not in the program`);
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
      this.host.overlay.set(file, out);
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
