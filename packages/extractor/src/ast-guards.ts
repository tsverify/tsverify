/**
 * The node tests the extractor needs that TypeScript 7's AST module (`typescript/ast`) does not
 * export, written against its `SyntaxKind` and `NodeFlags` (whose numbering differs from TS 6, so
 * they are always read from the loaded module). Same meaning as TypeScript 6's functions of the
 * same names.
 */
import type * as Ast from "typescript/unstable/ast";
import type * as TS from "./ts-types";

export interface AstGuards {
  isClassLike(node: TS.Node): node is TS.ClassLikeDeclaration;
  /** Any signature-bearing declaration: functions, methods, accessors, constructors, signatures. */
  isFunctionLike(node: TS.Node | undefined): node is TS.SignatureDeclaration;
  isIterationStatement(
    node: TS.Node,
    lookInLabeledStatements: boolean,
  ): node is TS.IterationStatementBase;
  /** A link of an optional chain (`a?.b`, `a?.()`, and what follows it in the same chain). */
  isOptionalChain(
    node: TS.Node,
  ): node is
    | TS.PropertyAccessExpression
    | TS.ElementAccessExpression
    | TS.CallExpression
    | TS.NonNullExpression;
  isParameter(node: TS.Node): node is TS.ParameterDeclaration;
  isPropertySignature(node: TS.Node): node is TS.PropertySignatureDeclaration;
  isTypeAssertionExpression(node: TS.Node): node is TS.TypeAssertion;
}

export function astGuards(ast: typeof Ast): AstGuards {
  const K = ast.SyntaxKind;
  const functionLike = new Set<TS.SyntaxKind>([
    K.FunctionDeclaration,
    K.MethodDeclaration,
    K.Constructor,
    K.GetAccessor,
    K.SetAccessor,
    K.FunctionExpression,
    K.ArrowFunction,
    K.MethodSignature,
    K.CallSignature,
    K.JSDocSignature,
    K.ConstructSignature,
    K.IndexSignature,
    K.FunctionType,
    K.ConstructorType,
  ]);
  const iteration = new Set<TS.SyntaxKind>([
    K.ForStatement,
    K.ForInStatement,
    K.ForOfStatement,
    K.DoStatement,
    K.WhileStatement,
  ]);
  const chainLink = new Set<TS.SyntaxKind>([
    K.PropertyAccessExpression,
    K.ElementAccessExpression,
    K.CallExpression,
    K.NonNullExpression,
  ]);
  const guards: AstGuards = {
    isClassLike: (node): node is TS.ClassLikeDeclaration =>
      node.kind === K.ClassDeclaration || node.kind === K.ClassExpression,
    isFunctionLike: (node): node is TS.SignatureDeclaration =>
      node !== undefined && functionLike.has(node.kind),
    isIterationStatement: (node, lookInLabeledStatements): node is TS.IterationStatementBase => {
      if (iteration.has(node.kind)) return true;
      return (
        lookInLabeledStatements &&
        node.kind === K.LabeledStatement &&
        guards.isIterationStatement((node as TS.LabeledStatement).statement, true)
      );
    },
    isOptionalChain: (
      node,
    ): node is
      | TS.PropertyAccessExpression
      | TS.ElementAccessExpression
      | TS.CallExpression
      | TS.NonNullExpression =>
      chainLink.has(node.kind) && (node.flags & ast.NodeFlags.OptionalChain) !== 0,
    isParameter: (node): node is TS.ParameterDeclaration => node.kind === K.Parameter,
    isPropertySignature: (node): node is TS.PropertySignatureDeclaration =>
      node.kind === K.PropertySignature,
    isTypeAssertionExpression: (node): node is TS.TypeAssertion =>
      node.kind === K.TypeAssertionExpression,
  };
  return guards;
}
