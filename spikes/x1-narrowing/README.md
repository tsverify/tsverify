# Spike X1: from-state inference via narrowing

**Question** (`idea/4. prototype-plan.md` §8): can ts-morph give the **narrowed literal-union
type** of `entity.status` at an arbitrary write site, and what is the best way to ask?

**Answer: yes. Go.** Use **probe injection, "probe-first"**: before the checker runs, wrap
every candidate write `W` as `(ref.status, W)` in an in-memory overlay, then ask the checker
for the type of the injected read. On TS 6 (ts-morph) it gave the expected answer for all 14
required cases and all 17 limit cases. On the TS 7 native API it gave the same 31 answers,
3 to 5 times faster. The limits are TypeScript's own narrowing rules, not the technique. They
are listed below, and most of them make the from-set too *large* (a false "over-permissive"
finding), not too small.

## Run it

```sh
pnpm install                                        # from the repo root
pnpm exec tsx spikes/x1-narrowing/run.ts            # results table + timings (X1_SCALE=0 skips scaling)
pnpm exec vitest run --root spikes/x1-narrowing     # asserts the recommended technique
pnpm exec tsc -p spikes/x1-narrowing/tsconfig.json  # optional: type-check the spike code
```

Root CI (`pnpm run ci`) does not include this folder, except for Biome linting.

## Files

| File | What |
|---|---|
| `fixture/` | Tiny TS project: `Order.status: OrderStatus`, a 6-state literal union (`src/order.ts`); one function per guard style (`src/cases.ts`); limit cases (`src/limits.ts`). It type-checks with 0 diagnostics |
| `cases.ts` | Expected from-set per case (`expected` = what the checker answers, `truth` = the semantically right answer when it differs) |
| `narrowing.ts` | Write-site finder (syntactic) and the five techniques |
| `ts7.ts` | The probe-first technique on `typescript@7.0.2`'s unstable sync API (tsgo) |
| `run.ts` | Prints the tables and timings below |
| `narrowing.test.ts` | Asserts probe injection (probe-first, post-hoc, and on tsgo) on every case |

A **write site** is `x.status = v` (assignment) or `{ ...x, status: v }` (object literal with a
spread, e.g. `repo.save({ ...order, status: "refunded" })`). For a spread, the entity reference
is the spread expression.

## Techniques

| Id | Technique | How |
|---|---|---|
| T0 | naive | `checker.getTypeAtLocation(x.status)` on the assignment target. For spreads: the type of `x` at the spread, then its `status` property |
| T1 | nearest preceding read | Find the closest `x.status` read before the write (text order) and ask its type |
| T2 | **probe injection** | Rewrite `W` to `(x.status, W)`. The comma operator creates no flow node, so the probe read sees exactly the flow state just before `W`. Then ask the type of the probe. Two modes: **probe-first** (inject before any checker query; one program) and **post-hoc** (add probed copies to an already-checked project; costs a rebuild) |
| T3 | `getTypeOfSymbolAtLocation` | `checker.getTypeOfSymbolAtLocation(statusSymbol, nameNodeOfWrite)`. For spreads: the `status` symbol at the spread reference |
| T4 | synthetic ref + borrowed flow node | Build a detached `x.status` node with `ts.factory`, clear `NodeFlags.Synthesized`, set `parent`/`pos`, and copy the internal `flowNode` from the write target (or the spread identifier). Then `getTypeAtLocation` on it. **Uses TS internals** |

Why T0 and T3 fail. This is by design in the checker, not a bug:

- `getFlowTypeOfAccessExpression` returns the **declared** type when the property access is a
  definite assignment target. Flow narrowing is skipped for `x.status` on the left of `=`.
- `getTypeOfSymbolAtLocation` returns the write type for write locations. For any location
  that is not itself a read of the symbol, it returns the declared type ("since we have no
  control flow information for the hypothetical reference ... we simply return the declared
  type").
- Both do see **object-level** narrowing (`asserts o is PaidOrder`, `o is PaidOrder`) through a
  spread, because the spread identifier is a read. That is why cases 4b and 7b pass.

Why T1 fails: a read *before* the write is usually the guard itself, which is evaluated before
the narrowing it causes, or it lies in the *other* branch. In `if (o.status !== "paid") throw
new NotRefundable(o.status)`, the textually nearest read is the throw argument, narrowed to
"everything except paid", the exact opposite of the right answer.

## Results

`ALL` = the full declared union, which the extractor reports as **unconstrained**. `*` = not a
finite literal set (`string`, `any`). `expected` is what the TypeScript checker answers. Where
that differs from the semantically right answer, `truth` is shown. Those rows are TypeScript
limits that no technique can fix by asking the checker.

### Required cases

| case | expected | T0 | T1 | T2 | T3 | T4 | T2 on tsgo | T2 raw type (TS 6) |
|---|---|---|---|---|---|---|---|---|
| 1 if/throw | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 2 switch | {paid} | **X** ALL | **X** ALL | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 3 early return | {paid,shipped} | **X** ALL | **X** {paid,refunded,shipped} | ok {paid,shipped} | **X** ALL | ok {paid,shipped} | ok {paid,shipped} | `"paid" \| "shipped"` |
| 4a asserts status | {paid} | **X** ALL | **X** ALL | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 4b asserts order (spread) | {paid} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | ok {paid} | ok {paid} | `"paid"` |
| 5 ternary (spread) | {paid} | **X** ALL | **X** ALL | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 6 boolean helper (negative) | ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| 7a predicate on status | {paid,shipped} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded} | ok {paid,shipped} | **X** ALL | ok {paid,shipped} | ok {paid,shipped} | `"paid" \| "shipped"` |
| 7b predicate on order (spread) | {paid} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | ok {paid} | ok {paid} | `"paid"` |
| 8 aliased condition, mutable field | ALL (truth {paid}) | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| 8b aliased condition, readonly | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 9 multiple states | {paid,shipped} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded} | ok {paid,shipped} | **X** ALL | ok {paid,shipped} | ok {paid,shipped} | `"paid" \| "shipped"` |
| 10 tx callback | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| 11 spread to save() | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| **score** | | **4/14** | **2/14** | **14/14** | **4/14** | **14/14** | **14/14** | |

Case 4 and case 7 each have a status-level variant (`asserts status is "paid"`,
`s is "paid" | "shipped"`) and an object-level variant (`asserts order is PaidOrder`,
`order is PaidOrder`). The object-level variants write by spread, because `order.status =
"refunded"` on a `PaidOrder` would not type-check.

**Case 8 is the one required style the checker does not narrow.** TypeScript inlines an aliased
condition (`const ok = order.status === "paid"; if (!ok) …`) only when the narrowed reference is
constant: a `const` or never-reassigned parameter **and** a `readonly` property
(`isConstantReference`). `Order.status` is mutable, so the answer is `ALL`. Case 8b shows the
same code on a `Readonly<Order>`, which narrows. The extractor errs toward reporting
"unconstrained", not toward a wrong from-set. See mitigations under Risks.

### Limits

| case | expected | T0 | T1 | T2 | T3 | T4 | T2 on tsgo | T2 raw type (TS 6) |
|---|---|---|---|---|---|---|---|---|
| L1 string field, guarded | {paid} | **X** * | **X** * | ok {paid} | **X** * | ok {paid} | ok {paid} | `"paid"` |
| L2 string field, unguarded | * | ok * | ok * | ok * | ok * | ok * | ok * | `string` |
| L3 any entity | * (truth {paid}) | ok * | ok * | ok * | ok * | ok * | ok * | `any` |
| L4 generic T extends Order | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L5 TS enum | {paid} | **X** ALL | **X** {draft,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `StatusEnum.Paid` |
| L6 Prisma-style const enum | {paid} | **X** ALL | **X** {draft,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L7 const s = order.status | ALL (truth {paid}) | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| L8 destructured status | ALL (truth {paid}) | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| L9 array.includes guard | ALL (truth {paid,shipped}) | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| L10 inferred predicate | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L11 closure after guard | ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| L12 across await | {paid} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L13 ref reassigned | ALL | ok ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok ALL | ok ALL | ok ALL | ok ALL | `OrderStatus` |
| L14 loop + continue | {paid} | **X** ALL | **X** ALL | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L15 this.status | {paid,shipped} | **X** ALL | **X** {cancelled,draft,pending_payment,refunded} | ok {paid,shipped} | **X** ALL | ok {paid,shipped} | ok {paid,shipped} | `"paid" \| "shipped"` |
| L16 switch (true) | {paid} | **X** ALL | **X** ALL | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| L17 mutated by a call in between | {paid} (truth {draft}) | **X** ALL | **X** {cancelled,draft,pending_payment,refunded,shipped} | ok {paid} | **X** ALL | ok {paid} | ok {paid} | `"paid"` |
| **score** | | **7/17** | **6/17** | **17/17** | **7/17** | **17/17** | **17/17** | |

Notes:
- L1: a `string` field still narrows to a literal after an equality guard. But the declared
  domain is `*`, so "unconstrained" cannot be decided. L2 (no guard) is `*`.
- L5: TS `enum` members come back as enum literal types (`StatusEnum.Paid`). `.value` gives
  `"paid"`.
- L6 is the shape Prisma generates for enums: a const object plus
  `type X = (typeof X)[keyof typeof X]`. It is a plain literal union, so it works.
- L10: TS 5.5+ infers `s is "paid"` for an unannotated `return s === "paid"` helper. Case 6
  (an explicit `: boolean`) does not narrow.
- L11: property narrowing does not flow into a closure created after the guard. `ALL` is the
  conservative answer and is arguably correct, because the callback can run later. A write
  *inside* a callback that has its own guard (case 10) works.
- **L12 and L17 are unsound in the other direction**: the checker keeps `paid` across an
  `await` and across a call that mutates the entity. Narrowing describes the value that was
  read, not the state at write time. The atomicity check (doc 3, Part B) and an "entity passed
  to a call between guard and write" heuristic must cover this.

## Recommendation: probe-first injection (T2)

How it works (`narrowing.ts`: `findWriteSites`, `injectProbes`, `probeFirst`, `probeAnswer`):

1. **Syntax only:** find candidate write sites in every file the extractor will analyze
   (assignments to `.status`, `status:` properties in object literals or adapter-specific call
   shapes). No checker is created yet.
2. Rewrite each write expression `W` to `(ref.status, W)` and replace the file text in the
   in-memory project (ts-morph `createSourceFile(path, text, { overwrite: true })`; on TS 7,
   the API's `fs.readFile` callback). No newline is inserted, so **line numbers are unchanged**
   and only columns on probe lines shift (one offset table per file).
3. Create the checker once and ask `getTypeAtLocation(probe)` for every site. Convert the type
   to literals (`literalsOf`): union members that are string, number, or enum literals; `any`
   or `unknown` gives `*`; `never` gives `{}` (unreachable write); type parameters and indexed
   access types are resolved through their base constraint.

Why this one:
- **It is correct by construction.** The probe is a real read at the real program point, so the
  checker applies every narrowing rule it has (assertions, predicates, inferred predicates,
  `switch (true)`, aliased conditions where allowed, loops, `this`). We reimplement nothing.
- **It is public API only**, and it ports directly to TS 7 (verified, see below).
- **It is diagnostic-neutral**: the probed fixture still has 0 diagnostics (`x.status` is not
  "side-effect free" to the checker, so no TS2695 on the comma operator).
- In probe-first mode, **there is no re-check**: the probed program is the only program ever
  checked. The cost is one extra parse of the files that contain candidate sites.

Limits of the technique itself (beyond TypeScript's narrowing rules):
- The reference must be re-evaluable source text that is valid at the write: an identifier,
  `this`, or a property chain (`ctx.order`). Computed references
  (`(await load()).status = …`) give `*`.
- Sites must be known before the first type query. If the extractor discovers new sites
  later, `probePostHoc` still works but costs one program rebuild plus a lazy re-check
  (batch it; never do it per site).
- Positions in the probed program differ from the original. Map them back before reporting.
- Persistence adapters whose writes do not mention the entity (Prisma `update({ data: {
  status } })`) must supply the reference themselves (e.g. the variable from the preceding
  `findUnique` on the same model and id). The probe then wraps the update call.

**T4 (borrowed flow node)** is also 31/31 and needs no extra parse, but it depends on
undocumented internals (`node.flowNode`, `NodeFlags.Synthesized`, hand-set `parent`). It has
no equivalent on TS 7, where the AST lives in the Go process. Do not build on it.

## TypeScript version and TS 7

- **ts-morph 28.0.0 bundles TypeScript 6.0.2** (via `@ts-morph/common@0.29.1`). It does not
  use the repo root's `typescript@7.0.2`, which is the native Go compiler (a `tsc` binary plus
  an `unstable/*` API). The two coexist without conflict.
- TS 6 is the last JavaScript compiler line, so a ts-morph backend is pinned to TS 6 semantics.
  The narrowing rules this spike exercises behaved identically on TS 6.0.2 and TS 7.0.2.
- **`typescript@7.0.2` already ships an unstable sync API** (`typescript/unstable/sync`). It
  spawns tsgo and talks to it over IPC. It has batched `getTypeAtPosition` /
  `getTypeAtLocation`, snapshots, and **virtual-filesystem callbacks** (`fs.readFile`). Probe-first
  maps onto it directly. `ts7.ts` serves the probed files from memory, queries the position of
  each probe's `status` name, and gets **31/31 identical answers**. It is also covered by the
  vitest suite.
- Implications: the `TypeFacts` seam from doc 5 holds. A TS 7 backend is a small amount of code,
  not a rewrite. The API is explicitly *unstable* in 7.0, so pin the exact version and expect
  changes by 7.1. tsgo comes as a per-platform optional dependency
  (`@typescript/typescript-linux-x64`, …). Anything that relies on JS-side compiler internals
  (T4, custom transformers, hand-built nodes) has no TS 7 path.

## Proposed `TypeFacts` surface

Two phases, because the cheap mode needs every probe planned before the checker exists:

```ts
/** Sorted literal values, or "*" when the type is not a finite literal set (string, any, …). */
export type LiteralSet = readonly string[] | "*";

export interface NarrowRequest {
  file: string;
  /** Span of the expression the probe wraps: `x.status = v`, `{ ...x, status: v }`, or an
   *  adapter-chosen node such as `prisma.order.update({...})`. Original-file offsets. */
  span: { start: number; end: number };
  /** Side-effect-free reference valid at that point: "order", "this", "ctx.order". */
  ref: string;
  field: string; // "status"
}

export interface Narrowed {
  /** Literals the field can hold just before the write ([] = the write is unreachable). */
  values: LiteralSet;
  /** The field's declared literal domain at that reference. */
  declared: LiteralSet;
  /** true when values equals declared, or either is "*": the extractor reports "unconstrained". */
  unconstrained: boolean;
  /** Raw type text, for diagnostics ("\"paid\" | \"shipped\"", "StatusEnum.Paid"). */
  typeText: string;
}

export type NarrowHandle = { readonly __brand: "NarrowHandle" };

export interface TypeFacts {
  /**
   * Phase 1, syntax only. Must be called before the first type query: the backend injects
   * every probe into its overlay, so the program is checked once. Calling it again later is
   * allowed, but it costs one batched re-check.
   */
  planNarrowing(requests: readonly NarrowRequest[]): readonly NarrowHandle[];

  /** Phase 2: the narrowed literal set at a planned site. */
  narrowedLiteralsAt(handle: NarrowHandle): Narrowed;

  /** Positions reported to users are original-file positions (lines never change). */
  toOriginalPosition(file: string, overlayOffset: number): number;

  // …plus the other doc-5 facts: resolvedSymbol(node), callTargets(call), typeText(node), …
}
```

The `narrowedLiteralsAt(ref, node): string[] | "*"` shape from the brief is the phase-2 call.
`ref` and `node` are folded into the request so the backend owns probe placement. Backends:
`TsMorphTypeFacts` (TS 6, `createSourceFile(..., { overwrite: true })` overlay) and
`TsgoTypeFacts` (TS 7 sync API, `fs.readFile` overlay). For enums, the extractor should also
get the member name next to the value, so specs can bind states to either.

## Performance

Machine: 2 vCPUs, 3 GB RAM, shared with other agents. Numbers are ranges over 4 runs of
`run.ts` and are noisy (±50%). Node 20.19, TS 6.0.2 via ts-morph, tsgo 7.0.2.

**Fixture** (3 files, ~330 lines, 31 sites; a fresh project per technique, after a warm-up):

| Measurement | Time |
|---|---|
| Cold process, first project: load + full check | 411–545 ms |
| Project load (parse + tsconfig), warm process | 30–200 ms |
| First type query (creates program + checker) | 10–62 ms |
| Per-query average after the first (any technique) | 0.27–0.76 ms |
| Probe-first: load + inject + reparse | 59–77 ms |
| Probe post-hoc, batched (1 rebuild + 31 queries) | 33–56 ms |
| Probe post-hoc, per site (1 rebuild + 1 query) | 7–12 ms per site |
| tsgo: spawn + open project (overlay via virtual FS) | 27–59 ms |
| tsgo: 31 probe queries (1 batched call per file) | 4–8 ms |

**Scaling** (`X1_SCALE=100`: 203 files, ~27k lines, ~3,100 sites):

| Measurement | Time |
|---|---|
| Load (parse) | 210–389 ms |
| Baseline: T0 at every site, cold checker | 411–654 ms |
| T4 at every site, cold checker | 438–634 ms |
| T2 post-hoc: 1 rebuild + all probe queries | 554–975 ms |
| T2 probe-first: find sites + inject + reparse | 229–389 ms |
| T2 probe-first: all probe queries, cold checker | 266–526 ms |
| Reference: full `getPreEmitDiagnostics`, including load | 1155–1637 ms |
| **tsgo: spawn + open project** | **104–185 ms** |
| **tsgo: all ~3,100 probe queries** | **100–138 ms** |
| Peak RSS (several ts-morph projects alive) | 440–560 MB |

Takeaways:
- Probe queries cost the same as any other type query. Probe-first adds **one reparse** of
  the probed files (~10 ms per 1k lines here) and **no re-check**.
- Post-hoc per site is the trap: one program rebuild per site (7–12 ms on a 3-file program,
  far more on a real one). Always batch.
- **Walk raw `ts.Node`s, not ts-morph wrappers.** A first version used ts-morph's
  `forEachDescendant` and `replaceWithText`: on 27k lines, wrapping took ~650 ms and forgetting
  the wrappers ~890 ms. That was more than type-checking. The raw-node version is in
  `narrowing.ts`.
- The tsgo backend is about 3–5x faster end to end at this size, and its memory use is in a
  separate process.

## Risks for real codebases

1. **Unions widened to `string`.** DTOs typed `status: string`, `z.string()` instead of
   `z.enum`, a Prisma `String` column instead of an `enum`, `as string`, JSON input. Guarded
   writes still give literals (L1), but the domain is `*`, so "unconstrained" cannot be
   decided, and unguarded writes give `*` (L2). The extractor should report "unknown domain",
   not "over-permissive", and suggest a literal union.
2. **`any`.** Untyped `req.body`, `JSON.parse`, untyped libraries, or `as any` give `*` even
   with a guard (L3). Report it as unknown. Projects without `strict` or `noImplicitAny` will
   hit this a lot.
3. **Generics.** `T extends Order` narrowed fine (L4). Deeper generic code (generic
   repositories, `Partial<T>` patches, mapped types) can leave `T["status"]` unresolved.
   `literalsOf` falls back to the base constraint, which is the declared domain, so the error
   is conservative.
4. **Prisma-generated enum types.** The generated `const X = {…}` plus
   `type X = (typeof X)[keyof typeof X]` shape works (L6). Caveats: result types are deep
   conditional types (`GetFindResult<…>`), so resolving them costs more checker time.
   `select`/`include` can drop `status`, which gives `*`. `update({ data })` writes carry no
   entity reference, so the adapter has to supply it. Drizzle `pgEnum` / `text({ enum })`
   produce literal unions too, but were not tested here.
5. **TS enums.** The narrowed type is the enum literal (L5). Use `.value` for string enums. For
   numeric enums, use the member name, because the value is a number. Specs need a rule for
   binding states to enum values or names.
6. **Idioms TypeScript does not narrow** (the answer becomes `ALL`, a false
   "over-permissive"): `REFUNDABLE.includes(s)` / `Set.has` (L9), copying the status into a
   local (L7) or destructuring it (L8), aliased conditions on mutable fields (case 8), plain
   `boolean` helpers (case 6), and guards outside a closure (L11). Possible mitigations, in
   rough order of value:
   - Put a hint in the finding: "use a type predicate (`s is …`) or an `asserts` helper".
   - Also probe a `const` alias (`const s = order.status`) at the write and intersect, when
     nothing writes the reference in between.
   - Recognize `const TUPLE = [...] as const; if (!TUPLE.includes(x.status))` in the adapter.
7. **Unsound narrowing** (the answer is too *small*): narrowing survives `await` (L12), calls
   that mutate the entity (L17), and writes through aliases (`const o2 = order`). This is the
   check-then-act gap that the atomicity analysis exists for. The extractor should also flag
   "entity passed to a call between guard and write".
8. **Placement.** Writes through computed references, element access (`orders[i].status`), or
   setters/methods (`order.markRefunded()`) need either interprocedural handling or `*`. A
   method write uses `this.status` inside the method (L15 works). The call graph has to carry
   the caller's narrowing into the callee, which this spike does not cover.
9. **Scale.** The cost is type-checking what the probes touch, which on real repos is
   dominated by ORM and framework types. Probe-first keeps it to one check. A ts-morph process
   on a ~200k-LOC repo will likely need 1–2 GB, so prefer the tsgo backend once its API
   stabilizes.

## Go / no-go

**Go** for from-state inference via narrowing, using probe-first injection behind
`TypeFacts`, with a ts-morph (TS 6.0.2) backend now and a tsgo (TS 7) backend that this spike
already shows to be feasible.

Caveats to carry into M5:
- The from-set is what TypeScript can prove about the **value read**, not the entity's state
  at write time. Pair it with the atomicity check, and treat L12/L17-style gaps as
  check-then-act risks.
- Some common idioms make TypeScript give up (case 8, L7–L9). They over-approximate to
  "unconstrained", so expect some false "over-permissive" findings until mitigations land.
- Site discovery must be syntactic (or over-approximate) so that probes are planned before the
  first type query.
- Adapters (Prisma first) must supply the entity reference for writes that do not mention it.
