import type { CmpOp, Expr } from "@tsverify/ir";
import { lex, type RuleSyntaxError, type Token } from "./lexer";

/**
 * Recursive-descent parser for rule expressions (docs/behavior-format.md, `rules[]`):
 *
 *   expr    := implies
 *   implies := or ( "implies" or )*          (right-associative)
 *   or      := and ( "or" and )*
 *   and     := not ( "and" not )*
 *   not     := "not" not | atom
 *   atom    := "status" ("==" | "!=") STATE
 *            | "status" "in" "[" STATE ("," STATE)* "]"
 *            | "count" "(" "effect" EFFECT ")" CMP INT
 *            | "true" | "false"
 *            | "(" expr ")"
 *
 * Only syntax is checked here; whether STATE / EFFECT names are declared is `validate.ts`'s job,
 * which is why every name is also returned as a `NameRef` with its position.
 */

/** A state or effect name used in an expression, with its 0-based span in the source text. */
export interface NameRef {
  kind: "state" | "effect";
  name: string;
  offset: number;
  end: number;
}

export type ParseResult = { expr: Expr; refs: NameRef[] } | { error: RuleSyntaxError };

const CMP_OPS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="]);
const ATOM_START = '"status", "count", "true", "false", "not" or "("';

class ParseFailure {
  constructor(readonly error: RuleSyntaxError) {}
}

class Parser {
  private pos = 0;
  readonly refs: NameRef[] = [];

  constructor(private readonly tokens: Token[]) {}

  parseExpr(): Expr {
    const left = this.parseOr();
    if (this.isWord("implies")) {
      this.pos++;
      return { type: "implies", left, right: this.parseExpr() };
    }
    return left;
  }

  finish(): void {
    const tok = this.peek();
    if (tok.kind !== "eof") {
      this.fail(tok, `unexpected ${describe(tok)} (expected "and", "or", "implies" or the end)`);
    }
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isWord("or")) {
      this.pos++;
      left = { type: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isWord("and")) {
      this.pos++;
      left = { type: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.isWord("not")) {
      this.pos++;
      return { type: "not", expr: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Expr {
    const tok = this.next();
    if (tok.kind === "word") {
      switch (tok.text) {
        case "status":
          return this.parseStatus();
        case "count":
          return this.parseCount();
        case "true":
          return { type: "bool", value: true };
        case "false":
          return { type: "bool", value: false };
      }
    }
    if (tok.kind === "punct" && tok.text === "(") {
      const expr = this.parseExpr();
      this.expectPunct(")", 'to close "("');
      return expr;
    }
    return this.fail(tok, `expected ${ATOM_START} but found ${describe(tok)}`);
  }

  private parseStatus(): Expr {
    const tok = this.next();
    if (tok.kind === "op" && (tok.text === "==" || tok.text === "!=")) {
      const value = this.expectName("state", `a state name after "status ${tok.text}"`);
      return { type: "status-cmp", op: tok.text, value };
    }
    if (tok.kind === "word" && tok.text === "in") {
      this.expectPunct("[", 'after "status in"');
      const values = [this.expectName("state", 'a state name after "["')];
      while (this.isPunct(",")) {
        this.pos++;
        values.push(this.expectName("state", 'a state name after ","'));
      }
      this.expectPunct("]", "to close the state list");
      return { type: "status-in", values };
    }
    return this.fail(tok, `expected "==", "!=" or "in" after "status" but found ${describe(tok)}`);
  }

  private parseCount(): Expr {
    this.expectPunct("(", 'after "count"');
    const kw = this.next();
    if (!(kw.kind === "word" && kw.text === "effect")) {
      this.fail(kw, `expected "effect" after "count(" but found ${describe(kw)}`);
    }
    const effect = this.expectName("effect", 'an effect name after "count(effect"');
    this.expectPunct(")", 'to close "count("');
    const op = this.next();
    if (op.kind !== "op" || !CMP_OPS.has(op.text)) {
      this.fail(
        op,
        `expected a comparison (==, !=, <, <=, >, >=) after "count(…)" but found ${describe(op)}`,
      );
    }
    const int = this.next();
    if (int.kind !== "int") {
      this.fail(int, `expected an integer after "${op.text}" but found ${describe(int)}`);
    }
    const value = Number(int.text);
    if (!Number.isSafeInteger(value)) this.fail(int, `integer ${int.text} is too large`);
    return { type: "effect-count", effect, op: op.text as CmpOp, value };
  }

  private expectName(kind: NameRef["kind"], what: string): string {
    const tok = this.next();
    if (tok.kind !== "word") this.fail(tok, `expected ${what} but found ${describe(tok)}`);
    this.refs.push({ kind, name: tok.text, offset: tok.offset, end: tok.end });
    return tok.text;
  }

  private expectPunct(text: string, why: string): void {
    const tok = this.next();
    if (!(tok.kind === "punct" && tok.text === text)) {
      this.fail(tok, `expected "${text}" ${why} but found ${describe(tok)}`);
    }
  }

  private isWord(text: string): boolean {
    const tok = this.peek();
    return tok.kind === "word" && tok.text === text;
  }

  private isPunct(text: string): boolean {
    const tok = this.peek();
    return tok.kind === "punct" && tok.text === text;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== "eof") this.pos++;
    return tok;
  }

  private fail(tok: Token, message: string): never {
    throw new ParseFailure({ message, offset: tok.offset });
  }
}

function describe(tok: Token): string {
  return tok.kind === "eof" ? "the end of the expression" : `"${tok.text}"`;
}

/** Parses a rule expression, also returning every state / effect name it references. */
export function parseRule(text: string): ParseResult {
  const lexed = lex(text);
  if ("error" in lexed) return lexed;
  if (lexed.tokens.length === 1) {
    return { error: { message: `empty expression (expected ${ATOM_START})`, offset: 0 } };
  }
  const parser = new Parser(lexed.tokens);
  try {
    const expr = parser.parseExpr();
    parser.finish();
    return { expr, refs: parser.refs };
  } catch (e) {
    if (e instanceof ParseFailure) return { error: e.error };
    throw e;
  }
}

/** Public form of `parseRule`: the expression AST or a syntax error with its 0-based offset. */
export function parseRuleExpr(
  text: string,
): { expr: Expr } | { error: { message: string; offset: number } } {
  const result = parseRule(text);
  return "error" in result ? { error: result.error } : { expr: result.expr };
}
