/**
 * The TypeScript the extractor reads code with: the analyzed project's own TypeScript 7, found at
 * runtime by `loadTypeScript` (`load-typescript.ts`) and installed for the analysis modules by
 * `useTypeScript`.
 *
 * Source modules import types only (`import type * as TS from "./ts-types"`) and every runtime
 * value (`ts.SyntaxKind`, `ts.isIdentifier`, `ts.TypeFlags`, …) through the live `ts` binding
 * here: the AST module, the checker's flag enums, and the few node tests TypeScript 7 does not
 * export (`ast-guards.ts`). Enum numbering differs between TypeScript versions, so it never
 * hard-codes a number.
 */
import type * as Ast from "typescript/unstable/ast";
import type * as Sync from "typescript/unstable/sync";
import { type AstGuards, astGuards } from "./ast-guards";

/** A loaded TypeScript 7: its synchronous API and its AST module. */
export interface TypeScript {
  /** The package version, e.g. `7.0.2`. */
  version: string;
  /** `typescript/sync` (7.1+) or `typescript/unstable/sync` (7.0). */
  sync: typeof Sync;
  /** `typescript/ast` (7.1+) or `typescript/unstable/ast` (7.0). */
  ast: typeof Ast;
}

type CheckerEnums = Pick<
  typeof Sync,
  "DiagnosticCategory" | "ObjectFlags" | "SignatureKind" | "SymbolFlags" | "TypeFlags"
>;

export type Ts = typeof Ast & CheckerEnums & AstGuards;

/** The compiler in use. Set by `useTypeScript` (`extractAll` does it) before any analysis. */
export let ts: Ts = undefined as unknown as Ts;

/** The module `ts` was built from: what `loadProject` starts the compiler with. */
export let typescript: TypeScript = undefined as unknown as TypeScript;

export function useTypeScript(module: TypeScript): void {
  if (module === typescript) return;
  const { DiagnosticCategory, ObjectFlags, SignatureKind, SymbolFlags, TypeFlags } = module.sync;
  ts = {
    ...module.ast,
    DiagnosticCategory,
    ObjectFlags,
    SignatureKind,
    SymbolFlags,
    TypeFlags,
    ...astGuards(module.ast),
  };
  typescript = module;
}
