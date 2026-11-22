/**
 * Fakes stand in for real clients, so a call the fake does not know must fail loudly: a silent
 * `undefined` would let the code under test take a path the replay never meant. `strict` wraps a
 * fake client so that any unknown member, at any depth, is a stub that throws a clear error when
 * called, naming the full call path and what to add to the instrument config.
 */

/** Thrown when the code under test calls a member a fake does not implement. */
export class UninstrumentedCallError extends Error {
  override readonly name = "UninstrumentedCallError";
  /** Full call path, e.g. `db.orders.list`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/**
 * Members probed by `await`, test frameworks, loggers and pretty-printers. Reporting these as
 * missing would break `await client`, `expect(client)` and `console.log(client)`.
 */
const PROBED: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "asymmetricMatch",
  "nodeType",
  "tagName",
  "inspect",
  "constructor",
  "prototype",
  "length",
  "name",
]);

function isProbe(prop: string | symbol): boolean {
  return (
    typeof prop === "symbol" ||
    PROBED.has(prop) ||
    prop.startsWith("__") ||
    prop.startsWith("$$") ||
    prop.startsWith("@@")
  );
}

/** Explains a missing member: `path` is the full call path, e.g. `db.orders.list`. */
export type MissingMemberHint = (path: string) => string;

function missing(path: string, hint: MissingMemberHint): unknown {
  const stub = () => {
    throw new UninstrumentedCallError(path, hint(path));
  };
  return new Proxy(stub, {
    get(target, prop, receiver) {
      if (isProbe(prop)) return Reflect.get(target, prop, receiver);
      return missing(`${path}.${String(prop)}`, hint);
    },
  });
}

/**
 * Wraps `target` so unknown members throw on call. Plain-object members are wrapped too, once,
 * so `client.orders === client.orders` still holds.
 */
export function strict<T extends object>(target: T, path: string, hint: MissingMemberHint): T {
  const wrapped = new Map<string, unknown>();
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (!(prop in obj) && !isProbe(prop)) return missing(`${path}.${String(prop)}`, hint);
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof prop !== "string" || !isPlainObject(value)) return value;
      let member = wrapped.get(prop);
      if (member === undefined) {
        member = strict(value, `${path}.${prop}`, hint);
        wrapped.set(prop, member);
      }
      return member;
    },
  });
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
