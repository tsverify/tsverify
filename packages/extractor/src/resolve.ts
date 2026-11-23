/**
 * Spec links → code: `impl` → function, `bindings.clients` → exported value, `bindings.guards` →
 * function. Paths are project-root-relative (docs/behavior-format.md, "Paths"). A link that does
 * not resolve is reported by the caller as `broken-link`.
 */
import type { ClientBinding, GuardBinding, StorageFunction, SymbolRef } from "@tsverify/ir";
import { type FunctionLike, isFunctionLike } from "./cfg";
import { primaryDeclarationOf } from "./declarations";
import type { ProjectContext } from "./project";
import type * as TS from "./ts-types";
import { ts } from "./typescript";

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail<T>(reason: string): Resolved<T> {
  return { ok: false, reason };
}

export function resolveAlias(sym: TS.Symbol, checker: TS.Checker): TS.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** The symbol an expression (identifier or `a.b` name) refers to, through import aliases. */
export function symbolOf(node: TS.Node, checker: TS.Checker): TS.Symbol | undefined {
  const target = ts.isPropertyAccessExpression(node) ? node.name : node;
  const sym = checker.getSymbolAtLocation(target);
  return sym && resolveAlias(sym, checker);
}

function stripExpr(e: TS.Expression): TS.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * The function a declaration stands for: a function/method declaration with a body, a variable
 * or property initialized with a function expression, or a higher-order wrapper call
 * (`export const handler = withAuth(async (ctx) => …)`, the last function argument).
 */
export function functionOfDeclaration(decl: TS.Node | undefined): FunctionLike | undefined {
  if (!decl) return undefined;
  if (isFunctionLike(decl)) return decl.body ? decl : undefined;
  let init: TS.Expression | undefined;
  if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) init = decl.initializer;
  else if (ts.isPropertyDeclaration(decl)) init = decl.initializer;
  if (!init) return undefined;
  const e = stripExpr(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isCallExpression(e)) {
    for (let i = e.arguments.length - 1; i >= 0; i--) {
      const a = stripExpr(e.arguments[i] as TS.Expression);
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
    }
  }
  return undefined;
}

/** A top-level symbol of a project file by name: exports first (handles re-exports), then locals. */
function topLevelSymbol(
  ctx: ProjectContext,
  sf: TS.SourceFile,
  name: string,
): TS.Symbol | undefined {
  const checker = ctx.checker;
  const moduleSym = checker.getSymbolAtLocation(sf);
  if (moduleSym) {
    const exp = checker.getExportsOfModule(moduleSym).find((s) => s.name === name);
    if (exp) return resolveAlias(exp, checker);
  }
  for (const st of sf.statements) {
    let id: TS.Node | undefined;
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) {
      id = st.name;
    } else if (ts.isVariableStatement(st)) {
      id = st.declarationList.declarations.find(
        (d) => ts.isIdentifier(d.name) && d.name.text === name,
      )?.name;
    }
    if (id) {
      const sym = checker.getSymbolAtLocation(id);
      if (sym) return sym;
    }
  }
  return undefined;
}

function projectFile(ctx: ProjectContext, file: string): Resolved<TS.SourceFile> {
  const sf = ctx.sourceFile(ctx.abs(file));
  if (!sf || !ctx.isAnalyzed(sf)) return fail(`${file} is not part of the TypeScript project`);
  return { ok: true, value: sf };
}

function propertyOf(checker: TS.Checker, sym: TS.Symbol, name: string): TS.Symbol | undefined {
  const type = checker.getTypeOfSymbol(sym);
  return type && checker.getPropertyOfType(type, name);
}

/**
 * What a `file#Head.member` path's head is, when it is a class or a type (an interface, a type
 * alias): the kinds of export generated tests can't replace with a plain fake object.
 */
export function pathHeadKind(ctx: ProjectContext, ref: SymbolRef): "class" | "type" | undefined {
  const sf = ctx.sourceFile(ctx.abs(ref.file));
  const head = sf && topLevelSymbol(ctx, sf, ref.symbol.split(".")[0] as string);
  if (!head) return undefined;
  if (head.flags & ts.SymbolFlags.Class) return "class";
  if (!(head.flags & ts.SymbolFlags.Value)) return "type";
  return undefined;
}

/**
 * Whether an impl function is an instance member of a class: a method (or accessor) without
 * `static`, or a function held in an instance field (`handle = async () => …`).
 */
export function isInstanceMember(fn: FunctionLike): boolean {
  const member: TS.Node =
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isPropertyDeclaration(fn.parent)
      ? fn.parent
      : fn;
  if (!ts.isClassLike(member.parent)) return false;
  const modifiers = (member as { modifiers?: readonly TS.Node[] }).modifiers ?? [];
  return !modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

/** `file#symbol` or `file#Class.method` → the symbol. */
function resolveSymbolPath(ctx: ProjectContext, file: string, symbol: string): Resolved<TS.Symbol> {
  const sf = projectFile(ctx, file);
  if (!sf.ok) return sf;
  const [head, ...members] = symbol.split(".");
  let sym = topLevelSymbol(ctx, sf.value, head as string);
  if (!sym) return fail(`${file} has no top-level symbol "${head}"`);
  for (const m of members) {
    const next: TS.Symbol | undefined =
      sym.getMembers().get(m as TS.__String) ?? propertyOf(ctx.checker, sym, m);
    if (!next) return fail(`${sym.name} has no member "${m}"`);
    sym = next;
  }
  return { ok: true, value: sym };
}

export function resolveImpl(ctx: ProjectContext, ref: SymbolRef): Resolved<FunctionLike> {
  const sym = resolveSymbolPath(ctx, ref.file, ref.symbol);
  if (!sym.ok) return sym;
  const fn = functionOfDeclaration(primaryDeclarationOf(sym.value));
  if (!fn) return fail(`${ref.file}#${ref.symbol} is not a function with a body`);
  return { ok: true, value: fn };
}

export function resolveClient(ctx: ProjectContext, binding: ClientBinding): Resolved<TS.Symbol> {
  const sf = projectFile(ctx, binding.module);
  if (!sf.ok) return sf;
  const checker = ctx.checker;
  const moduleSym = checker.getSymbolAtLocation(sf.value);
  const exp =
    moduleSym && checker.getExportsOfModule(moduleSym).find((s) => s.name === binding.export);
  if (!exp) return fail(`${binding.module} does not export "${binding.export}"`);
  const sym = resolveAlias(exp, checker);
  if (!(sym.flags & ts.SymbolFlags.Value)) {
    return fail(`${binding.module}#${binding.export} is a type, not a value`);
  }
  return { ok: true, value: sym };
}

/** A `bindings.storage` function: `file#symbol` (or `file#obj.method`) that can be called. */
export function resolveStorageFunction(
  ctx: ProjectContext,
  fn: StorageFunction,
): Resolved<TS.Symbol> {
  const sym = resolveSymbolPath(ctx, fn.ref.file, fn.ref.symbol);
  if (!sym.ok) return sym;
  const type = ctx.checker.getTypeOfSymbol(sym.value);
  const callable =
    type !== undefined && ctx.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
  if (!callable) return fail(`${fn.ref.file}#${fn.ref.symbol} is not a function`);
  return sym;
}

export function resolveGuard(ctx: ProjectContext, binding: GuardBinding): Resolved<TS.Symbol> {
  const sym = resolveSymbolPath(ctx, binding.file, binding.symbol);
  if (!sym.ok) return sym;
  const decl = primaryDeclarationOf(sym.value);
  if (!functionOfDeclaration(decl)) {
    return fail(`${binding.file}#${binding.symbol} is not a function with a body`);
  }
  return sym;
}
