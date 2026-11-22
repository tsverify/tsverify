/**
 * Frames and the bounded call-graph walk from an impl.
 *
 * A **frame** is a named function-like (function/method declaration, or a function expression
 * stored in a variable or property) together with its inline callbacks (see `cfg.ts`). An inline
 * callback is its own frame only when nothing encloses it (a top-level `withAuth(async (ctx) => …)`).
 *
 * The walk follows calls whose resolved declaration is a function with a body in a project file
 * (not a declaration file, not `node_modules`). It stops at calls the caller marks as stops
 * (bound client calls: never descend into a client's implementation; bound guard calls) and at
 * `MAX_DEPTH` call levels below the impl.
 */
import { ts } from "ts-morph";
import { type FunctionLike, inlineCallbackCall, isFunctionLike } from "./cfg";
import type { ProjectContext } from "./project";
import { functionOfDeclaration, symbolOf } from "./resolve";

export const MAX_DEPTH = 8;

function hasEnclosingFunction(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return true;
  return false;
}

/** The frame a node belongs to: its nearest enclosing function-like that is not an inline callback. */
export function frameOf(node: ts.Node): FunctionLike | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!isFunctionLike(n)) continue;
    if (inlineCallbackCall(n) && hasEnclosingFunction(n)) continue;
    return n;
  }
  return undefined;
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function containerName(member: ts.Node): string | undefined {
  const parent = member.parent;
  if (ts.isClassLike(parent)) return nameText(parent.name) ?? "anonymous";
  if (ts.isObjectLiteralExpression(parent)) {
    const holder = parent.parent;
    if (holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder))) {
      return nameText(holder.name);
    }
  }
  return undefined;
}

/** The identifier that names a frame, and its display name (`refundOrder`, `Repo.save`). */
export function frameNaming(fn: FunctionLike): { name: string; node: ts.Node } {
  const qualified = (member: ts.Node, n: string) => {
    const c = containerName(member);
    return c === undefined ? n : `${c}.${n}`;
  };
  if (ts.isFunctionDeclaration(fn)) {
    return { name: fn.name?.text ?? "default", node: fn.name ?? fn };
  }
  if (ts.isConstructorDeclaration(fn)) return { name: qualified(fn, "constructor"), node: fn };
  if (
    ts.isMethodDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn)
  ) {
    return { name: qualified(fn, nameText(fn.name) ?? "anonymous"), node: fn.name };
  }
  // Function expression: named by what holds it, walking out of wrappers and HOF calls.
  let child: ts.Node = fn;
  for (let p = fn.parent; p; child = p, p = p.parent) {
    if (ts.isVariableDeclaration(p) && nameText(p.name))
      return { name: nameText(p.name) as string, node: p.name };
    if (ts.isPropertyAssignment(p) && p.initializer === child) {
      const n = nameText(p.name) ?? "anonymous";
      return { name: qualified(p, n), node: p.name };
    }
    if (ts.isPropertyDeclaration(p) && nameText(p.name)) {
      return { name: qualified(p, nameText(p.name) as string), node: p.name };
    }
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isCallExpression(p) ||
      ts.isAwaitExpression(p)
    ) {
      continue;
    }
    break;
  }
  if (ts.isFunctionExpression(fn) && fn.name) return { name: fn.name.text, node: fn.name };
  return { name: "anonymous", node: fn };
}

const callsMemo = new WeakMap<FunctionLike, ts.CallExpression[]>();

/** Calls in a frame (including its inline callbacks), in source order. */
export function frameCalls(fn: FunctionLike): ts.CallExpression[] {
  const cached = callsMemo.get(fn);
  if (cached) return cached;
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  callsMemo.set(fn, out);
  return out;
}

/** Resolves calls to project-local functions with bodies. Shared by every spec. */
export class Callees {
  private readonly memo = new Map<ts.CallExpression, FunctionLike | null>();

  constructor(private readonly ctx: ProjectContext) {}

  of(call: ts.CallExpression): FunctionLike | undefined {
    const cached = this.memo.get(call);
    if (cached !== undefined) return cached ?? undefined;
    const fn = this.resolve(call);
    this.memo.set(call, fn ?? null);
    return fn;
  }

  private resolve(call: ts.CallExpression): FunctionLike | undefined {
    const checker = this.ctx.checker;
    let decl: ts.Declaration | undefined = checker.getResolvedSignature(call)?.declaration;
    if (!decl || ts.isJSDocSignature(decl)) {
      decl = symbolOf(call.expression, checker)?.valueDeclaration;
    }
    const fn =
      decl && (isFunctionLike(decl) ? (decl.body ? decl : undefined) : functionOfDeclaration(decl));
    if (!fn || !this.ctx.isAnalyzed(fn.getSourceFile())) return undefined;
    return fn;
  }
}

export interface CallEdge {
  caller: FunctionLike;
  call: ts.CallExpression;
  callee: FunctionLike;
}

export interface Reach {
  root: FunctionLike;
  /** Frames reached, root first, breadth-first. */
  frames: FunctionLike[];
  edges: CallEdge[];
}

export function reach(
  root: FunctionLike,
  callees: Callees,
  isStop: (call: ts.CallExpression) => boolean,
): Reach {
  const frames: FunctionLike[] = [root];
  const depth = new Map<FunctionLike, number>([[root, 0]]);
  const edges: CallEdge[] = [];
  for (let i = 0; i < frames.length; i++) {
    const caller = frames[i] as FunctionLike;
    const d = depth.get(caller) as number;
    if (d >= MAX_DEPTH) continue;
    for (const call of frameCalls(caller)) {
      if (isStop(call)) continue;
      const callee = callees.of(call);
      if (!callee) continue;
      edges.push({ caller, call, callee });
      if (!depth.has(callee)) {
        depth.set(callee, d + 1);
        frames.push(callee);
      }
    }
  }
  return { root, frames, edges };
}
