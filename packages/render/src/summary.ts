import type { Actor, BehaviorModel, CmpOp, EffectDecl, Expr, Rule, Transition } from "@tsv/ir";
import { compareStrings } from "./compare";
import { isNonAtomicOnce } from "./mermaid";

/**
 * A plain-English Markdown summary of a model, built only from its structure: an overview
 * paragraph, one bullet per transition, and one bullet per rule. The same model always gives
 * the same text (no randomness, dates or locale-dependent ordering).
 */
export function summarize(model: BehaviorModel): string {
  const noun = entityNoun(model.entity.name);
  const out = [overview(model, noun), "", "**Transitions**", ""];

  const transitions = [...model.transitions].sort((a, b) => compareStrings(a.name, b.name));
  if (transitions.length === 0) out.push("No transitions are declared.");
  for (const t of transitions) out.push(`- ${transitionSentence(model, t, noun)}`);

  out.push("", "**Rules**", "");
  if (model.rules.length === 0) out.push("No rules are declared.");
  for (const r of model.rules) out.push(`- ${ruleSentence(r, noun)}`);

  return `${out.join("\n")}\n`;
}

function overview(model: BehaviorModel, noun: string): string {
  const { entity } = model;
  const parts = [`**${md(model.name)}**${/[.!?]$/.test(model.name) ? "" : "."}`];
  const summary = model.summary?.trim();
  if (summary) parts.push(`${md(summary)}${/[.!?]$/.test(summary) ? "" : "."}`);
  if (model.origin === "code") parts.push("This model was extracted from the code.");

  const count = entity.states.length;
  const states = joinList(entity.states.map(md), "and");
  parts.push(
    count === 0
      ? `${capitalize(article(noun))} ${noun} has no states.`
      : `${capitalize(article(noun))} ${noun} has ${count} ${count === 1 ? "state" : "states"}: ${states}.`,
  );
  const ends =
    entity.terminal.length === 0
      ? "has no terminal state"
      : `ends as ${joinList(entity.terminal.map(md), "or")}`;
  parts.push(`It starts as ${md(entity.initial)} and ${ends}.`);
  return parts.join(" ");
}

function transitionSentence(model: BehaviorModel, t: Transition, noun: string): string {
  const actors = joinList(
    t.by.map((a) => actorPhrase(a, model.actors[a], t)),
    "or",
  );
  let source: string;
  if (t.from === "*") {
    source = `${article(noun)} ${noun} in any state`;
  } else {
    const order = new Map(model.entity.states.map((s, i) => [s, i]));
    const from = [...new Set(t.from)].sort(
      (a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    const first = from[0] ?? "";
    source = `${article(first)} ${joinList(from.map(md), "or")} ${noun}`;
  }
  const timer = t.after === undefined ? "" : ` after ${md(t.after)}`;
  let text = `**${md(t.name)}**: ${actors} can move ${source} to ${md(t.to)}${timer}.`;

  const clauses: string[] = [];
  if (t.effects.length > 0) clauses.push(`issues ${joinList(t.effects.map(effectPhrase), "and")}`);
  clauses.push(t.atomic ? "is atomic" : "is not atomic");
  if (t.idempotent) clauses.push("tolerates duplicate delivery (idempotent)");
  text += ` This ${joinList(clauses, "and")}.`;

  if (isNonAtomicOnce(t)) {
    const once = t.effects.filter((e) => e.multiplicity === "exactly-once").map((e) => md(e.name));
    text +=
      " ⚠ The state check and the write are separate steps, so concurrent runs could issue " +
      `${joinList(once, "or")} more than once.`;
  }
  return text;
}

function actorPhrase(name: string, actor: Actor | undefined, t: Transition): string {
  const guards = [...new Set([...t.requires, ...(actor?.requires ?? [])].map((g) => g.raw))].sort(
    compareStrings,
  );
  let phrase: string;
  switch (actor?.trust) {
    case "internal":
      phrase = `the ${md(name)}`;
      break;
    case "signed-webhook":
      phrase = `${article(name)} ${md(name)} webhook`;
      break;
    default:
      phrase = `${article(name)} ${md(name)}`;
  }
  const notes: string[] = [];
  if (actor?.trust === "untrusted") notes.push("untrusted");
  if (guards.length > 0) notes.push(`requires ${joinList(guards.map(md), "and")}`);
  else if (actor?.trust === "untrusted") notes.push("no guard");
  return notes.length === 0 ? phrase : `${phrase} (${notes.join(", ")})`;
}

function effectPhrase(e: EffectDecl): string {
  switch (e.multiplicity) {
    case "exactly-once":
      return `${md(e.name)} exactly once`;
    case "at-least-once":
      return `${md(e.name)} at least once`;
    case "idempotent":
      return `${md(e.name)} idempotently`;
  }
}

const RULE_KIND = { always: "Always", never: "Never", eventually: "Eventually" } as const;

function ruleSentence(r: Rule, noun: string): string {
  const name = `**${md(r.name)}${/[.!?]$/.test(r.name) ? "" : "."}**`;
  return `${name} ${RULE_KIND[r.kind]}: ${exprPhrase(r.expr, noun)}. ${codeSpan(r.source)}`;
}

/** Plain-English reading of a rule expression. Mixed and/or/implies nesting is parenthesised. */
function exprPhrase(e: Expr, noun: string): string {
  switch (e.type) {
    case "status-cmp":
      return `the ${noun} is ${e.op === "!=" ? "not " : ""}${md(e.value)}`;
    case "status-in":
      return `the ${noun} is ${joinList(e.values.map(md), "or")}`;
    case "effect-count":
      return `${md(e.effect)} ${countPhrase(e.op, e.value)}`;
    case "bool":
      return e.value ? "true" : "false";
    case "not":
      return `it is not the case that ${nested(e.expr, "not", noun)}`;
    case "and":
    case "or":
      return `${nested(e.left, e.type, noun)} ${e.type} ${nested(e.right, e.type, noun)}`;
    case "implies":
      return `if ${nested(e.left, "implies", noun)}, then ${nested(e.right, "implies", noun)}`;
  }
}

function nested(e: Expr, parent: "and" | "or" | "implies" | "not", noun: string): string {
  const text = exprPhrase(e, noun);
  const binary = e.type === "and" || e.type === "or" || e.type === "implies";
  return binary && e.type !== parent ? `(${text})` : text;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function countPhrase(op: CmpOp, n: number): string {
  switch (op) {
    case "==":
      return n === 0 ? "has not happened" : `has happened exactly ${times(n)}`;
    case "!=":
      return n === 0 ? "has happened" : `has not happened exactly ${times(n)}`;
    case "<":
      return n <= 1 ? "has not happened" : `has happened fewer than ${times(n)}`;
    case "<=":
      return n <= 0 ? "has not happened" : `has happened at most ${times(n)}`;
    case ">":
      return n <= 0 ? "has happened" : `has happened more than ${times(n)}`;
    case ">=":
      return n <= 1 ? "has happened" : `has happened at least ${times(n)}`;
  }
}

/** `Order` → `order`, `SupportTicket` → `support ticket`, `line_item` → `line item`. */
function entityNoun(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words.length === 0 ? "entity" : md(words.join(" ").toLowerCase());
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `a`, `a and b`, `a, b and c`. */
function joinList(items: string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Escapes Markdown syntax in model-supplied text. Underscores inside a word (`pending_payment`)
 * are left alone, since CommonMark does not treat them as emphasis.
 */
function md(text: string): string {
  return text
    .replace(/[\\`*[\]<>|]/g, (c) => `\\${c}`)
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\\_");
}

function codeSpan(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
