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
import { type FunctionLike, inlineCallbackCall, isFunctionLike } from "./cfg";
import { signatureDeclarationOf, valueDeclarationOf } from "./declarations";
import type { ProjectContext } from "./project";
import { functionOfDeclaration, symbolOf } from "./resolve";
import type * as TS from "./ts-types";
import { ts } from "./typescript";

export const MAX_DEPTH = 8;

function hasEnclosingFunction(n: TS.Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return true;
  return false;
}

/** The frame a node belongs to: its nearest enclosing function-like that is not an inline callback. */
export function frameOf(node: TS.Node): FunctionLike | undefined {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    if (!isFunctionLike(n)) continue;
    if (inlineCallbackCall(n) && hasEnclosingFunction(n)) continue;
    return n;
  }
  return undefined;
}

function nameText(name: TS.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function containerName(member: TS.Node): string | undefined {
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
export function frameNaming(fn: FunctionLike): { name: string; node: TS.Node } {
  const qualified = (member: TS.Node, n: string) => {
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
  let child: TS.Node = fn;
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

const callsMemo = new WeakMap<FunctionLike, TS.CallExpression[]>();

/** Calls in a frame (including its inline callbacks), in source order. */
export function frameCalls(fn: FunctionLike): TS.CallExpression[] {
  const cached = callsMemo.get(fn);
  if (cached) return cached;
  const out: TS.CallExpression[] = [];
  const visit = (n: TS.Node): void => {
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (ts.isCallExpression(n)) out.push(n);
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  callsMemo.set(fn, out);
  return out;
}

/** Resolves calls to project-local functions with bodies. Shared by every spec. */
export class Callees {
  private readonly memo = new Map<TS.CallExpression, FunctionLike | null>();

  constructor(private readonly ctx: ProjectContext) {}

  of(call: TS.CallExpression): FunctionLike | undefined {
    const cached = this.memo.get(call);
    if (cached !== undefined) return cached ?? undefined;
    const fn = this.resolve(call);
    this.memo.set(call, fn ?? null);
    return fn;
  }

  private resolve(call: TS.CallExpression): FunctionLike | undefined {
    const checker = this.ctx.checker;
    let decl = signatureDeclarationOf(checker.getResolvedSignature(call));
    if (!decl || ts.isJSDocSignature(decl)) {
      decl = valueDeclarationOf(symbolOf(call.expression, checker));
    }
    const fn =
      decl && (isFunctionLike(decl) ? (decl.body ? decl : undefined) : functionOfDeclaration(decl));
    if (!fn || !this.ctx.isAnalyzed(fn.getSourceFile())) return undefined;
    return fn;
  }
}

export interface CallEdge {
  caller: FunctionLike;
  call: TS.CallExpression;
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
  isStop: (call: TS.CallExpression) => boolean,
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

/** A node of a frame that leads to a write: the write itself, or a call into a frame that leads to it. */
export interface LeadGroup {
  node: TS.Node;
  callee?: FunctionLike;
}

/**
 * The lead nodes of every frame in `root`'s reach towards `write` (in `writeFrame`): the write
 * itself in its frame, plus each call edge whose callee (transitively) leads to it. Frames that do
 * not lead to the write get `[]`. Recursive re-entry adds nothing.
 */
export function leadsTo(
  root: Reach,
  writeFrame: FunctionLike,
  write: TS.Node,
): (fn: FunctionLike) => LeadGroup[] {
  const memo = new Map<FunctionLike, LeadGroup[]>();
  const leads = (fn: FunctionLike, stack: Set<FunctionLike>): LeadGroup[] => {
    const cached = memo.get(fn);
    if (cached) return cached;
    if (stack.has(fn)) return [];
    stack.add(fn);
    const groups: LeadGroup[] = fn === writeFrame ? [{ node: write }] : [];
    for (const e of root.edges) {
      if (e.caller !== fn) continue;
      if (leads(e.callee, stack).length > 0) groups.push({ node: e.call, callee: e.callee });
    }
    stack.delete(fn);
    memo.set(fn, groups);
    return groups;
  };
  return (fn) => leads(fn, new Set());
}
