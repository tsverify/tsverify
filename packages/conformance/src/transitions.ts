import {
  type BehaviorModel,
  type CodeSites,
  compareStrings,
  type Finding,
  formatSymbolRef,
  type SourceLocation,
  type Transition,
  type UnreadWrite,
} from "@tsverify/ir";
import { formatStates, makeFinding, type Pairing } from "./finding";

/** Code transitions grouped by the spec transition whose impl reaches them. */
export interface Links {
  /** Spec transition name → linked code transitions (sorted by name). */
  linked: Map<string, Transition[]>;
  /** Code transitions with no `sites.specTransition` (sorted by name). */
  unlinked: Transition[];
}

/** Returns the code facts of a code-model transition; their absence is a programmer error. */
export function sitesOf(code: Transition): CodeSites {
  if (code.sites === undefined) {
    throw new Error(`conformance: code transition "${code.name}" has no sites`);
  }
  return code.sites;
}

/**
 * Groups code transitions by `sites.specTransition`. A link to a spec transition that does not
 * exist, or that has no `impl` (the extractor only links through an impl), means the code model
 * was not built from this spec: a programmer error, so it throws.
 */
export function linkTransitions(spec: BehaviorModel, code: BehaviorModel): Links {
  const specByName = new Map(spec.transitions.map((t) => [t.name, t]));
  const linked = new Map<string, Transition[]>();
  const unlinked: Transition[] = [];
  const sorted = [...code.transitions].sort((a, b) => compareStrings(a.name, b.name));
  for (const c of sorted) {
    // A spec transition copied into the code model as assumed behavior: it has no `impl`, or its
    // impl only reaches writes tsverify couldn't read (`unreadWrites`; reported in `checkLinked`).
    if (c.sites === undefined && specByName.has(c.name)) {
      const t = specByName.get(c.name) as Transition;
      if (t.impl === undefined || (code.unreadWrites?.[t.name]?.length ?? 0) > 0) continue;
    }
    const target = sitesOf(c).specTransition;
    if (target === undefined) {
      unlinked.push(c);
      continue;
    }
    const t = specByName.get(target);
    if (t === undefined) {
      throw new Error(
        `conformance: code transition "${c.name}" links to unknown spec transition "${target}"`,
      );
    }
    if (t.impl === undefined) {
      throw new Error(
        `conformance: code transition "${c.name}" links to spec transition "${target}", which has no impl`,
      );
    }
    const list = linked.get(target) ?? [];
    list.push(c);
    linked.set(target, list);
  }
  return { linked, unlinked };
}

function stateNote(spec: BehaviorModel, state: string): string {
  return spec.entity.states.includes(state)
    ? ""
    : ` ('${state}' is not a state of ${spec.entity.name})`;
}

/** A write no spec transition's impl reaches, e.g. B1's `reopenOrder`. */
export function checkUnlinked(spec: BehaviorModel, c: Transition): Finding {
  const sites = sitesOf(c);
  return makeFinding({
    category: "undeclared-transition",
    severity: "error",
    behavior: spec.name,
    transition: c.name,
    message:
      `${sites.function.name} writes ${formatStates(c.from)} → ${c.to}, which no spec transition ` +
      `declares${stateNote(spec, c.to)}.`,
    hint: `Declare this transition in the spec with impl: ${sites.function.file}#${sites.function.name}, or remove the write.`,
    codeAt: sites.write,
  });
}

/**
 * The id subject of the `unanalyzable` finding for a transition whose impl changes the state only
 * in forms tsverify can't read: `unanalyzable:<behavior>:<transition>:unconfirmed`.
 */
export const UNCONFIRMED_SUBJECT = "unconfirmed";

/** `set-status.ts:64`: a location in a message, by file name (findings carry the full path). */
function shortAt(at: SourceLocation): string {
  return `${at.file.slice(at.file.lastIndexOf("/") + 1)}:${at.line}`;
}

/**
 * Splits the code transitions linked to `t` into its primary writes (those writing `t.to`) and
 * reports the rest: `undeclared-transition` for every linked write to another state, and, when
 * there is no primary write, `missing-transition`, unless the impl reaches state writes tsverify
 * couldn't read (`unread`, the code model's `unreadWrites[t.name]`, minus those known to write
 * another state). Then it can't say the impl never writes `t.to`, so it reports the transition as
 * unconfirmed (`unanalyzable`, caused by those writes' own findings). `implAt` (the code model's
 * `implAt[t.name]`) is the `codeAt` of a missing transition: the impl's declaration, since the
 * write itself is not there.
 */
export function checkLinked(
  spec: BehaviorModel,
  t: Transition,
  linked: Transition[],
  implAt?: SourceLocation,
  unread: readonly UnreadWrite[] = [],
): { pairings: Pairing[]; findings: Finding[] } {
  const pairings: Pairing[] = [];
  const findings: Finding[] = [];
  const specAt = t.at === undefined ? {} : { specAt: t.at };
  for (const c of linked) {
    const sites = sitesOf(c);
    if (c.to === t.to) {
      pairings.push({ spec, t, code: c, sites });
      continue;
    }
    findings.push(
      makeFinding({
        category: "undeclared-transition",
        severity: "error",
        behavior: spec.name,
        transition: t.name,
        subject: c.name,
        message:
          `${t.name}: ${sites.function.name} also writes ${formatStates(c.from)} → ${c.to}, but ` +
          `${t.name} only goes to ${t.to}${stateNote(spec, c.to)}.`,
        hint: `Remove the write to ${c.to}, or declare it as its own transition in the spec.`,
        ...specAt,
        codeAt: sites.write,
      }),
    );
  }
  const field = spec.entity.stateField;
  const unconfirmed = unread.filter((u) => u.value === undefined || u.value === t.to);
  if (pairings.length === 0 && t.impl !== undefined && unconfirmed.length > 0) {
    const where =
      unconfirmed.length === 1
        ? `${shortAt((unconfirmed[0] as UnreadWrite).at)} in a form tsverify can't read (${(unconfirmed[0] as UnreadWrite).reason})`
        : `${unconfirmed.map((u) => `${shortAt(u.at)} (${u.reason})`).join(" and ")}, in forms tsverify can't read`;
    const finding = makeFinding({
      category: "unanalyzable",
      severity: "warning",
      behavior: spec.name,
      transition: t.name,
      subject: UNCONFIRMED_SUBJECT,
      message:
        `${t.name}: couldn't confirm that ${t.impl.symbol} writes ${field} = ${t.to}: it changes ` +
        `${field} at ${where}.`,
      hint:
        `Restructure the write so tsverify can read it: ${field} = '${t.to}' as a literal, through ` +
        `the storage the spec binds (docs/authoring-guide.md §7.5). Until then ${t.name} is not checked against the code.`,
      ...specAt,
      codeAt: (unconfirmed[0] as UnreadWrite).at,
    });
    finding.causedBy = [...new Set(unconfirmed.map((u) => u.finding))];
    findings.push(finding);
  } else if (pairings.length === 0 && t.impl !== undefined) {
    findings.push(
      makeFinding({
        category: "missing-transition",
        severity: "error",
        behavior: spec.name,
        transition: t.name,
        message: `${t.name}: ${formatSymbolRef(t.impl)} never writes ${spec.entity.stateField} = ${t.to}.`,
        hint: `Set ${spec.entity.stateField} to '${t.to}' in ${t.impl.symbol} (or a function it calls), or fix impl.`,
        ...specAt,
        ...(implAt === undefined ? {} : { codeAt: implAt }),
      }),
    );
  }
  return { pairings, findings };
}

/** A spec transition without `impl` cannot be compared with the code. */
export function checkNoImpl(spec: BehaviorModel, t: Transition): Finding {
  return makeFinding({
    category: "unanalyzable",
    severity: "info",
    behavior: spec.name,
    transition: t.name,
    message: `${t.name}: not linked to code (no impl), so it is not checked against the code.`,
    hint: `Add impl: path/to/file.ts#function to ${t.name} to check it against the code.`,
    ...(t.at === undefined ? {} : { specAt: t.at }),
  });
}
