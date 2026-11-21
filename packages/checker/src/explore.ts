import type { Layout } from "./encode";
import { type Action, applyAction, isBudgetLimited, isEnabled } from "./semantics";

/**
 * Visited set + BFS queue + parent pointers in one structure.
 *
 * States are fixed-width `Uint16Array` rows stored back to back. Ids are assigned in discovery
 * order, which in BFS is also the queue order, so the queue is just "every id not yet expanded".
 * Lookup is an open-addressing hash table (linear probing) over the rows.
 */
export class StateStore {
  readonly width: number;
  size = 0;
  /** Row storage: state `id` occupies `[id * width, (id + 1) * width)`. */
  rows: Uint16Array;
  /** Parent state id per state (-1 for the initial state). */
  parent: Int32Array;
  /** Index of the action that discovered each state (-1 for the initial state). */
  via: Int32Array;
  private hashes: Int32Array;
  /** Slot → state id + 1 (0 = empty). Capacity is a power of two. */
  private table: Int32Array;
  private mask: number;

  constructor(width: number, initialCapacity = 1024) {
    this.width = width;
    this.rows = new Uint16Array(initialCapacity * width);
    this.parent = new Int32Array(initialCapacity);
    this.via = new Int32Array(initialCapacity);
    this.hashes = new Int32Array(initialCapacity);
    this.table = new Int32Array(initialCapacity * 2);
    this.mask = initialCapacity * 2 - 1;
  }

  static hash(v: Uint16Array, width: number): number {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < width; i++) h = Math.imul(h ^ (v[i] as number), 0x01000193);
    return (h ^ (h >>> 15)) | 0;
  }

  /** Id of the state equal to `v`, or -1. */
  find(v: Uint16Array, hash: number): number {
    const { table, rows, width, hashes } = this;
    let slot = hash & this.mask;
    for (;;) {
      const entry = table[slot] as number;
      if (entry === 0) return -1;
      const id = entry - 1;
      if (hashes[id] === hash) {
        const base = id * width;
        let i = 0;
        while (i < width && rows[base + i] === v[i]) i++;
        if (i === width) return id;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  /** Adds `v` (known to be absent) and returns its id. */
  add(v: Uint16Array, hash: number, parent: number, via: number): number {
    if (this.size === this.parent.length) this.grow();
    const id = this.size++;
    this.rows.set(v, id * this.width);
    this.parent[id] = parent;
    this.via[id] = via;
    this.hashes[id] = hash;
    this.insertSlot(id, hash);
    return id;
  }

  /** Copies the row of state `id` into `out`. */
  read(id: number, out: Uint16Array): void {
    const base = id * this.width;
    out.set(this.rows.subarray(base, base + this.width));
  }

  private insertSlot(id: number, hash: number): void {
    let slot = hash & this.mask;
    while (this.table[slot] !== 0) slot = (slot + 1) & this.mask;
    this.table[slot] = id + 1;
  }

  private grow(): void {
    const capacity = this.parent.length * 2;
    const rows = new Uint16Array(capacity * this.width);
    rows.set(this.rows);
    this.rows = rows;
    const parent = new Int32Array(capacity);
    parent.set(this.parent);
    this.parent = parent;
    const via = new Int32Array(capacity);
    via.set(this.via);
    this.via = via;
    const hashes = new Int32Array(capacity);
    hashes.set(this.hashes);
    this.hashes = hashes;
    // Keep the load factor at or below 1/2.
    this.table = new Int32Array(capacity * 2);
    this.mask = capacity * 2 - 1;
    for (let id = 0; id < this.size; id++) this.insertSlot(id, this.hashes[id] as number);
  }
}

/** Callbacks run during exploration. `state` is only valid during the call. */
export interface ExploreVisitor {
  /** A newly discovered state (including the initial one). */
  onState(id: number, state: Uint16Array): void;
  /** An expanded state with no enabled action. */
  onDeadlock(id: number, state: Uint16Array, budgetLimited: boolean): void;
}

export interface Exploration {
  store: StateStore;
  edges: number;
  /** false when `maxStates` stopped the search early. */
  complete: boolean;
}

/** Breadth-first search from `initial`, so every parent chain is a shortest path. */
export function explore(
  layout: Layout,
  actions: readonly Action[],
  initial: Uint16Array,
  maxStates: number,
  visitor: ExploreVisitor,
): Exploration {
  const width = layout.width;
  const store = new StateStore(width);
  const cur = new Uint16Array(width);
  const next = new Uint16Array(width);
  let edges = 0;

  store.add(initial, StateStore.hash(initial, width), -1, -1);
  visitor.onState(0, initial);

  for (let id = 0; id < store.size; id++) {
    store.read(id, cur);
    let successors = 0;
    for (let a = 0; a < actions.length; a++) {
      const action = actions[a] as Action;
      if (!isEnabled(action, cur)) continue;
      successors++;
      edges++;
      next.set(cur);
      applyAction(action, next);
      const hash = StateStore.hash(next, width);
      if (store.find(next, hash) !== -1) continue;
      if (store.size >= maxStates) return { store, edges, complete: false };
      visitor.onState(store.add(next, hash, id, a), next);
    }
    if (successors === 0) visitor.onDeadlock(id, cur, isBudgetLimited(layout, cur));
  }
  return { store, edges, complete: true };
}
