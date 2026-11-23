/**
 * TypeScript 7's types, for `import type * as TS from "./ts-types"`: the AST (`TS.Node`,
 * `TS.CallExpression`, …) and the checker's objects (`TS.Checker`, `TS.Symbol`, `TS.Type`, …).
 *
 * The extractor compiles against the monorepo's TypeScript 7.0, whose API lives under
 * `typescript/unstable/*`; at runtime `loadTypeScript` also takes 7.1's stable `typescript/sync`
 * and `typescript/ast`, which have the same shapes for everything used here.
 */
export type * from "typescript/unstable/ast";
export type {
  API,
  Checker,
  Diagnostic,
  IndexInfo,
  NodeHandle,
  Program,
  Project,
  Signature,
  Snapshot,
  Symbol,
  Type,
} from "typescript/unstable/sync";
