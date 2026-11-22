/**
 * The TypeScript compiler the extractor reads code with: the classic JavaScript compiler API of
 * the analyzed project's own TypeScript, found at runtime by `loadTypeScript`
 * (`load-typescript.ts`) and installed for the analysis modules by `useTypeScript`.
 *
 * Source modules import types only (`import type * as TS from "@typescript/typescript6"`) and
 * every runtime value (`ts.SyntaxKind`, `ts.isIdentifier`, …) through the live `ts` binding here.
 */
import type * as TS from "@typescript/typescript6";

export type TypeScript = typeof TS;

/** The compiler in use. Set by `useTypeScript` (`extractAll` does it) before any analysis. */
export let ts: TypeScript = undefined as unknown as TypeScript;

export function useTypeScript(module: TypeScript): void {
  ts = module;
}
