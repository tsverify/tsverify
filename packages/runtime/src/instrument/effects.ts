/**
 * `instrument.effects`: a recording fake for an effect client (payments, email, queues). Each
 * configured call path becomes an async method that passes a gate, records the call (worker,
 * arguments, order) and returns a fake result. Nothing leaves the process.
 */
import type { GateKind } from "../gates";
import type { EffectCall, Scheduler } from "../scheduler";
import { strict } from "./strict";

/** An async method of an effects fake. */
export type EffectMethod = (...args: unknown[]) => Promise<unknown>;

type Head<P extends string> = P extends `${infer H}.${string}` ? H : P;
type Tail<P extends string, H extends string> = P extends `${H}.${infer R}` ? R : never;

/** `"refunds.create" | "refunds.list"` → `{ refunds: { create: EffectMethod; list: EffectMethod } }`. */
export type EffectsClient<P extends string> = {
  [H in Head<P>]: [Tail<P, H>] extends [never] ? EffectMethod : EffectsClient<Tail<P, H>>;
};

export interface EffectsConfig<P extends string = string> {
  /** Client binding name and gate prefix, e.g. `stripe` → gate `stripe.refunds.create`. */
  client: string;
  /** Call paths below the client (`CallSite.path`), e.g. `["refunds.create"]`. */
  calls: readonly P[];
  /**
   * Fake result per call path; `n` counts calls of that path in the current run, from 1.
   * Default: `{ id: "<path with _>_fake_<n>" }`, e.g. `{ id: "refunds_create_fake_1" }`.
   */
  returns?: Partial<Record<P, (args: readonly unknown[], n: number) => unknown>>;
  /** Default `transparent`: effects are passed on the way to the next sync gate. */
  gate?: GateKind;
}

export interface EffectsFake<P extends string = string> {
  /** What the mocked module exports in place of the real client. */
  client: EffectsClient<P>;
  /** Calls of one path (e.g. `refunds.create`) in the current run, in order. */
  calls(path: P): EffectCall[];
}

function copyArgs(args: readonly unknown[]): readonly unknown[] {
  try {
    return structuredClone(args);
  } catch {
    return [...args]; // functions, class instances with private state: keep the references
  }
}

export function effects<const P extends string>(
  s: Scheduler,
  config: EffectsConfig<P>,
): EffectsFake<P> {
  const owner = `effects fake "${config.client}"`;
  const root: Record<string, unknown> = {};
  const counters = new Map<string, number>();
  s.onReset(() => counters.clear());

  for (const path of config.calls) {
    const label = `${config.client}.${path}`;
    const parts = path.split(".");
    const method = parts.pop();
    if (!method || parts.some((p) => p === "")) {
      throw new Error(`${owner}: invalid call path ${JSON.stringify(path)}`);
    }
    let node = root;
    for (const part of parts) {
      const next = node[part] ?? {};
      if (typeof next !== "object") {
        throw new Error(`${owner}: call path ${JSON.stringify(path)} conflicts with another path`);
      }
      node[part] = next;
      node = next as Record<string, unknown>;
    }
    if (method in node) {
      throw new Error(`${owner}: call path ${JSON.stringify(path)} is listed twice or conflicts`);
    }
    s.defineGate(label, config.gate ?? "transparent", owner);
    const make = config.returns?.[path];
    node[method] = async (...args: unknown[]): Promise<unknown> => {
      await s.gate(label, copyArgs(args));
      s.recordEffect(label, copyArgs(args));
      const n = (counters.get(label) ?? 0) + 1;
      counters.set(label, n);
      return make ? make(args, n) : { id: `${path.replaceAll(".", "_")}_fake_${n}` };
    };
  }

  const known = config.calls.map((p) => `${config.client}.${p}`).join(", ");
  const client = strict(root, config.client, (path) => {
    const rel = path.slice(config.client.length + 1);
    return (
      `${path} is not instrumented: the effects fake for client "${config.client}" only ` +
      `records ${known || "nothing"}. If the code under test really calls it, add ` +
      `${JSON.stringify(rel)} to the fake's \`calls\` (and, if it is a spec effect, map the ` +
      "effect to it in `bindings.effects`)."
    );
  }) as EffectsClient<P>;

  return {
    client,
    calls: (path) => s.effects(`${config.client}.${path}`),
  };
}
