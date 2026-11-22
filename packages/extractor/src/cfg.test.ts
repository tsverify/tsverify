import { describe, expect, it } from "vitest";
import { installTypeScript } from "../test/typescript";
import { buildCfg, ENTRY, EXIT, type FunctionLike, reachable } from "./cfg";

const ts = installTypeScript();

/**
 * Parses `function f() { … }` and answers: is the call to `target()` reachable from entry when
 * every call to `guard()` is removed? (true = the guard does not dominate the target).
 */
function bypassable(body: string): boolean {
  const sf = ts.createSourceFile(
    "f.ts",
    `function f(a: any, b: any) {${body}}`,
    ts.ScriptTarget.ES2022,
    true,
  );
  const fn = sf.statements[0] as FunctionLike;
  const cfg = buildCfg(fn);
  const callsTo = (name: string): number[] =>
    cfg.nodes.flatMap((n, id) =>
      n && ts.isCallExpression(n) && n.expression.getText(sf) === name ? [id] : [],
    );
  const seen = reachable(cfg, [ENTRY], new Set(callsTo("guard")));
  const targets = callsTo("target");
  if (targets.length === 0) throw new Error("no target() call");
  return targets.some((t) => seen[t] === 1);
}

describe("cfg: guard dominance by reachability", () => {
  it.each([
    ["straight line", "guard(); target();"],
    ["both branches", "if (a) guard(); else guard(); target();"],
    ["guard in condition", "if (guard()) target();"],
    ["throw on the other branch", "if (a) { guard(); } else { throw new Error(); } target();"],
    ["return on the other branch", "if (a) return; guard(); target();"],
    ["inside an inline callback", "guard(); run(() => { target(); });"],
    ["callback guard before target", "run(async (tx) => { guard(); target(); });"],
    ["try, guard throws past target", "try { guard(); target(); } catch { }"],
    ["finally rethrows", "try { guard(); } finally { b(); } target();"],
    ["switch: every clause", "switch (a) { case 1: guard(); break; default: guard(); } target();"],
  ])("dominated: %s", (_, body) => {
    expect(bypassable(body)).toBe(false);
  });

  it.each([
    ["one branch", "if (a) guard(); target();"],
    ["short-circuit", "a && guard(); target();"],
    ["optional call skips its arguments", "a?.x(guard()); target();"],
    ["conditional", "a ? guard() : 0; target();"],
    ["swallowed in catch", "try { guard(); } catch { } target();"],
    ["loop body may not run", "for (const x of a) guard(); target();"],
    ["while body may not run", "while (a) { guard(); } target();"],
    ["break before guard", "for (;;) { if (a) break; guard(); break; } target();"],
    [
      "labeled break",
      "outer: for (;;) { for (;;) { if (a) break outer; guard(); break; } break; } target();",
    ],
    ["continue skips guard", "do { if (a) continue; guard(); } while (b); target();"],
    ["guard after target", "target(); guard();"],
    [
      "switch fall-through without guard",
      "switch (a) { case 1: guard(); break; case 2: b(); } target();",
    ],
    ["callback may not run", "run(() => guard()); target();"],
    ["callback return skips guard", "run(() => { if (a) return; guard(); }); target();"],
  ])("not dominated: %s", (_, body) => {
    expect(bypassable(body)).toBe(true);
  });

  it.each([
    ["catch after the source", "try { source(); target(); } catch { other(); }", ["target"]],
    [
      "finally runs normally",
      "try { source(); } finally { target(); } other();",
      ["target", "other"],
    ],
    [
      "callback return reaches the caller",
      "run(() => { source(); return 1; }); target();",
      ["target"],
    ],
    ["throw skips the rest", "source(); if (a) throw b; target();", ["target"]],
  ])("normal completion (throw targets blocked): %s", (_, body, expected) => {
    const sf = ts.createSourceFile(
      "f.ts",
      `function f(a: any, b: any) {${body}}`,
      ts.ScriptTarget.ES2022,
      true,
    );
    const cfg = buildCfg(sf.statements[0] as FunctionLike);
    const calls = (name: string) =>
      cfg.nodes.flatMap((n, id) =>
        n && ts.isCallExpression(n) && n.expression.getText(sf) === name ? [id] : [],
      );
    const seen = reachable(cfg, calls("source"), cfg.throwTargets);
    const hit = ["target", "other"].filter((name) => calls(name).some((id) => seen[id] === 1));
    expect(hit).toEqual(expected);
  });

  it("reaches the normal exit only through returns and fall-through", () => {
    const sf = ts.createSourceFile(
      "f.ts",
      "function f() { throw new Error(); }",
      ts.ScriptTarget.ES2022,
      true,
    );
    const cfg = buildCfg(sf.statements[0] as FunctionLike);
    expect(reachable(cfg, [ENTRY])[EXIT]).toBe(0);
  });
});
