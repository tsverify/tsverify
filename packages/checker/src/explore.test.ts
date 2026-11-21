import { describe, expect, it } from "vitest";
import { StateStore } from "./explore";

describe("StateStore", () => {
  it("deduplicates rows and keeps ids, parents and actions across growth", () => {
    const width = 3;
    const store = new StateStore(width, 4);
    const row = (i: number) => Uint16Array.of(i % 7, (i * 31) % 65536, i >> 4);
    for (let i = 0; i < 5000; i++) {
      const v = row(i);
      const h = StateStore.hash(v, width);
      expect(store.find(v, h)).toBe(-1);
      expect(store.add(v, h, i - 1, i % 5)).toBe(i);
    }
    expect(store.size).toBe(5000);
    const out = new Uint16Array(width);
    for (const i of [0, 1, 4, 4095, 4999]) {
      const v = row(i);
      expect(store.find(v, StateStore.hash(v, width))).toBe(i);
      store.read(i, out);
      expect([...out]).toEqual([...v]);
      expect(store.parent[i]).toBe(i - 1);
      expect(store.via[i]).toBe(i % 5);
    }
    expect(
      store.find(Uint16Array.of(9, 9, 9), StateStore.hash(Uint16Array.of(9, 9, 9), width)),
    ).toBe(-1);
  });
});
