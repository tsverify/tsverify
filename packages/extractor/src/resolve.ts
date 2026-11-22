/**
 * Spec links → code: `impl` → function, `bindings.clients` → exported value, `bindings.guards` →
 * function. Paths are project-root-relative (docs/behavior-format.md, "Paths"). A link that does
 * not resolve is reported by the caller as `broken-link`.
 */
import type { ClientBinding, GuardBinding, SymbolRef } from "@tsv/ir";
import { ts } from "ts-morph";
import { type FunctionLike, isFunctionLike } from "./cfg";
import type { ProjectContext } from "./project";

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail<T>(reason: string): Resolved<T> {
  return { ok: false, reason };
}

export function resolveAlias(sym: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** The symbol an expression (identifier or `a.b` name) refers to, through import aliases. */
export function symbolOf(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const target = ts.isPropertyAccessExpression(node) ? node.name : node;
  const sym = checker.getSymbolAtLocation(target);
  return sym && resolveAlias(sym, checker);
}

function stripExpr(e: ts.Expression): ts.Expression {
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
export function functionOfDeclaration(decl: ts.Declaration | undefined): FunctionLike | undefined {
  if (!decl) return undefined;
  if (isFunctionLike(decl)) return decl.body ? decl : undefined;
  let init: ts.Expression | undefined;
  if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) init = decl.initializer;
  else if (ts.isPropertyDeclaration(decl)) init = decl.initializer;
  if (!init) return undefined;
  const e = stripExpr(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isCallExpression(e)) {
    for (let i = e.arguments.length - 1; i >= 0; i--) {
      const a = stripExpr(e.arguments[i] as ts.Expression);
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
    }
  }
  return undefined;
}

/** A top-level symbol of a project file by name: exports first (handles re-exports), then locals. */
function topLevelSymbol(
  ctx: ProjectContext,
  sf: ts.SourceFile,
  name: string,
): ts.Symbol | undefined {
  const checker = ctx.checker;
  const moduleSym = checker.getSymbolAtLocation(sf);
  if (moduleSym) {
    const exp = checker.getExportsOfModule(moduleSym).find((s) => s.name === name);
    if (exp) return resolveAlias(exp, checker);
  }
  for (const st of sf.statements) {
    let id: ts.Node | undefined;
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

function projectFile(ctx: ProjectContext, file: string): Resolved<ts.SourceFile> {
  const sf = ctx.sourceFile(ctx.abs(file));
  if (!sf || !ctx.isAnalyzed(sf)) return fail(`${file} is not part of the TypeScript project`);
  return { ok: true, value: sf };
}

/** `file#symbol` or `file#Class.method` → the symbol. */
function resolveSymbolPath(ctx: ProjectContext, file: string, symbol: string): Resolved<ts.Symbol> {
  const sf = projectFile(ctx, file);
  if (!sf.ok) return sf;
  const [head, ...members] = symbol.split(".");
  let sym = topLevelSymbol(ctx, sf.value, head as string);
  if (!sym) return fail(`${file} has no top-level symbol "${head}"`);
  for (const m of members) {
    const next: ts.Symbol | undefined =
      sym.members?.get(m as ts.__String) ??
      ctx.checker.getPropertyOfType(ctx.checker.getTypeOfSymbol(sym), m);
    if (!next) return fail(`${sym.name} has no member "${m}"`);
    sym = next;
  }
  return { ok: true, value: sym };
}

export function resolveImpl(ctx: ProjectContext, ref: SymbolRef): Resolved<FunctionLike> {
  const sym = resolveSymbolPath(ctx, ref.file, ref.symbol);
  if (!sym.ok) return sym;
  const fn = functionOfDeclaration(sym.value.valueDeclaration ?? sym.value.declarations?.[0]);
  if (!fn) return fail(`${ref.file}#${ref.symbol} is not a function with a body`);
  return { ok: true, value: fn };
}

export function resolveClient(ctx: ProjectContext, binding: ClientBinding): Resolved<ts.Symbol> {
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

export function resolveGuard(ctx: ProjectContext, binding: GuardBinding): Resolved<ts.Symbol> {
  const sym = resolveSymbolPath(ctx, binding.file, binding.symbol);
  if (!sym.ok) return sym;
  const decl = sym.value.valueDeclaration ?? sym.value.declarations?.[0];
  if (!functionOfDeclaration(decl)) {
    return fail(`${binding.file}#${binding.symbol} is not a function with a body`);
  }
  return sym;
}
