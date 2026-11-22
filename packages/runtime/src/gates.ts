/**
 * Gates: the points where an instrumented call suspends its worker until the schedule lets it
 * through. A gate's label is the client call path (`<client>.<path>`, e.g. `db.orders.get`), the
 * same string the extractor writes to `CallSite.gate`.
 *
 * - `sync`: a model-level synchronisation point (entity read or commit). A step can only pass
 *   the sync gate it names; reaching a different one is a divergence.
 * - `transparent`: an intermediate point (transaction begin, external effect). A step heading for
 *   another gate passes it automatically; a step can also name it explicitly to stop there.
 *   Transparent gates still serialise workers and are recorded in the gate log.
 */
export type GateKind = "sync" | "transparent";

/** One gate passed by a worker. */
export interface GateEvent {
  /** Position in the run, shared with `EffectCall.seq`. */
  seq: number;
  worker: string;
  gate: string;
  args: readonly unknown[];
}

interface GateDef {
  kind: GateKind;
  /** Which instrument defined it, for error messages (e.g. `store "db"`). */
  owner: string;
}

/** The gates every instrument of one scheduler defined. Labels are unique. */
export class GateRegistry {
  private readonly defs = new Map<string, GateDef>();

  define(label: string, kind: GateKind, owner: string): void {
    const prev = this.defs.get(label);
    if (prev) {
      throw new Error(
        `gate ${JSON.stringify(label)} is already defined (${prev.kind}) by ${prev.owner}; ` +
          `${owner} cannot define it again. Give each instrumented client a distinct name.`,
      );
    }
    this.defs.set(label, { kind, owner });
  }

  has(label: string): boolean {
    return this.defs.has(label);
  }

  kind(label: string): GateKind | undefined {
    return this.defs.get(label)?.kind;
  }

  /** Every label, in definition order. */
  labels(): string[] {
    return [...this.defs.keys()];
  }
}
