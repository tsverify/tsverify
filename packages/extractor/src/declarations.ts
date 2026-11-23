/**
 * Declarations of checker objects as AST nodes. TypeScript 7's API hands out `NodeHandle`s
 * (file + node index), resolved here against the project that produced them: the probed
 * program, so the node is the very object a walk of that program's source file reaches.
 */
import type * as TS from "./ts-types";

/** A symbol's value declaration (`valueDeclaration`), as a node. */
export function valueDeclarationOf(sym: TS.Symbol | undefined): TS.Node | undefined {
  return sym?.valueDeclaration?.resolve();
}

/** A symbol's declarations, as nodes. */
export function declarationsOf(sym: TS.Symbol): TS.Node[] {
  const out: TS.Node[] = [];
  for (const handle of sym.declarations) {
    const node = handle.resolve();
    if (node) out.push(node);
  }
  return out;
}

/** The value declaration, else the first declaration. */
export function primaryDeclarationOf(sym: TS.Symbol): TS.Node | undefined {
  return valueDeclarationOf(sym) ?? sym.declarations[0]?.resolve();
}

/** The declaration a resolved signature comes from, as a node. */
export function signatureDeclarationOf(sig: TS.Signature | undefined): TS.Node | undefined {
  return sig?.declaration?.resolve();
}
