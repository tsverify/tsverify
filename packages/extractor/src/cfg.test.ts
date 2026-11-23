import { afterAll, describe, expect, it } from "vitest";
import { openProject } from "../test/typescript";
import { buildCfg, type CfgOptions, ENTRY, EXIT, type FunctionLike, reachable } from "./cfg";
import type * as TS from "./ts-types";
import { ts } from "./typescript";

const DOMINATED: [string, string][] = [
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
];

const NOT_DOMINATED: [string, string][] = [
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
];

const NORMAL_COMPLETION: [string, string, string[]][] = [
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
];

const THROWS = "throw new Error();";
const SWITCH_NO_DEFAULT = "switch (a) { case 1: guard(); break; case 2: guard(); } target();";
const PICKED = "let v = b(); if (a) v = guard(); target(v);";

/** Every body as `function f(a: any, b: any) { … }` in a file of its own, parsed by TypeScript. */
const bodies = [
  ...new Set([
    ...[...DOMINATED, ...NOT_DOMINATED].map(([, body]) => body),
    ...NORMAL_COMPLETION.map(([, body]) => body),
    THROWS,
    SWITCH_NO_DEFAULT,
    PICKED,
  ]),
];
const project = openProject(
  Object.fromEntries(
    bodies.map((body, i) => [`case${i}.ts`, `function f(a: any, b: any) {${body}}\nexport {};\n`]),
  ),
);
afterAll(() => project.close());

function parsed(body: string): { sf: TS.SourceFile; fn: FunctionLike } {
  const name = `${project.root}/case${bodies.indexOf(body)}.ts`;
  const sf = project.files.find((f) => f.fileName === name);
  if (!sf) throw new Error(`${name} is not in the program`);
  return { sf, fn: sf.statements[0] as FunctionLike };
}

/**
 * Parses `function f() { … }` and answers: is the call to `target()` reachable from entry when
 * every call to `guard()` is removed? (true = the guard does not dominate the target).
 */
function bypassable(body: string, options?: CfgOptions): boolean {
  const { sf, fn } = parsed(body);
  const cfg = buildCfg(fn, options);
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
  it.each(DOMINATED)("dominated: %s", (_, body) => {
    expect(bypassable(body)).toBe(false);
  });

  it.each(NOT_DOMINATED)("not dominated: %s", (_, body) => {
    expect(bypassable(body)).toBe(true);
  });

  it.each(NORMAL_COMPLETION)(
    "normal completion (throw targets blocked): %s",
    (_, body, expected) => {
      const { sf, fn } = parsed(body);
      const cfg = buildCfg(fn);
      const calls = (name: string) =>
        cfg.nodes.flatMap((n, id) =>
          n && ts.isCallExpression(n) && n.expression.getText(sf) === name ? [id] : [],
        );
      const seen = reachable(cfg, calls("source"), cfg.throwTargets);
      const hit = ["target", "other"].filter((name) => calls(name).some((id) => seen[id] === 1));
      expect(hit).toEqual(expected);
    },
  );

  it("a switch without default said to cover every value has no path past its cases", () => {
    expect(bypassable(SWITCH_NO_DEFAULT)).toBe(true);
    expect(bypassable(SWITCH_NO_DEFAULT, { exhaustive: () => true })).toBe(false);
  });

  it("nodesOf adds a node for each picked read and declaration, in evaluation order", () => {
    const { fn } = parsed(PICKED);
    const isRead = (n: TS.Node) =>
      ts.isIdentifier(n) && n.text === "v" && ts.isCallExpression(n.parent);
    const cfg = buildCfg(fn, { nodesOf: (n) => isRead(n) || ts.isVariableDeclaration(n) });
    const ids = (test: (n: TS.Node) => boolean) =>
      cfg.nodes.flatMap((n, id) => (n && test(n) ? [id] : []));
    const [declared] = ids(ts.isVariableDeclaration);
    const [read] = ids(isRead);
    if (declared === undefined || read === undefined) throw new Error("no picked nodes");
    // The declaration's value reaches the read on the path that skips the assignment …
    const assigned = new Set(ids(ts.isBinaryExpression));
    expect(reachable(cfg, [declared], assigned)[read]).toBe(1);
    // … and no path reaches the read without passing the declaration.
    expect(reachable(cfg, [ENTRY], new Set([declared]))[read]).toBe(0);
  });

  it("reaches the normal exit only through returns and fall-through", () => {
    const cfg = buildCfg(parsed(THROWS).fn);
    expect(reachable(cfg, [ENTRY])[EXIT]).toBe(0);
  });
});
