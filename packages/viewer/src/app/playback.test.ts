import { describe, expect, it } from "vitest";
import { BASE_INTERVAL_MS, Playback, type PlaybackStatus } from "./playback";

/** The cursor bounds `playback.behavior.yaml` cannot state (see its header). */
function expectBounds(p: Playback): void {
  expect(p.cursor).toBeGreaterThanOrEqual(0);
  expect(p.cursor).toBeLessThanOrEqual(p.last);
  if (p.status === "idle") expect(p.cursor).toBe(0);
  if (p.status === "ended") expect(p.cursor).toBe(p.last);
}

/** Transitions allowed by the spec: status before → statuses it may move to. */
const ALLOWED: Record<PlaybackStatus, PlaybackStatus[]> = {
  idle: ["playing", "paused", "ended"],
  playing: ["paused", "ended", "idle"],
  paused: ["playing", "ended", "idle"],
  ended: ["playing", "paused", "idle"],
};

describe("Playback", () => {
  it("starts idle at the first step", () => {
    const p = new Playback(7);
    expect([p.status, p.cursor, p.last, p.speed]).toEqual(["idle", 0, 6, 1]);
  });

  it("rejects an empty trace", () => {
    expect(() => new Playback(0)).toThrow(/at least one step/);
  });

  it("plays to the last step and ends there", () => {
    const p = new Playback(3);
    p.play();
    expect(p.status).toBe("playing");
    p.tick();
    expect([p.status, p.cursor]).toEqual(["playing", 1]);
    p.tick();
    expect([p.status, p.cursor]).toEqual(["ended", 2]);
    p.tick();
    expect([p.status, p.cursor]).toEqual(["ended", 2]);
  });

  it("ends a one-step trace on the first tick", () => {
    const p = new Playback(1);
    p.play();
    p.tick();
    expect([p.status, p.cursor]).toEqual(["ended", 0]);
  });

  it("pauses and resumes where it was", () => {
    const p = new Playback(5);
    p.play();
    p.tick();
    p.pause();
    p.tick();
    expect([p.status, p.cursor]).toEqual(["paused", 1]);
    p.toggle();
    p.tick();
    expect([p.status, p.cursor]).toEqual(["playing", 2]);
    p.toggle();
    expect(p.status).toBe("paused");
  });

  it("restarts from the first step when played after the end", () => {
    const p = new Playback(2);
    p.seek(1);
    expect(p.status).toBe("ended");
    p.play();
    expect([p.status, p.cursor]).toEqual(["playing", 0]);
  });

  it("stepping by hand stops the clock, and only the last step ends", () => {
    const p = new Playback(4);
    p.step(1);
    expect([p.status, p.cursor]).toEqual(["paused", 1]);
    p.play();
    p.step(1);
    expect([p.status, p.cursor]).toEqual(["paused", 2]);
    p.step(1);
    expect([p.status, p.cursor]).toEqual(["ended", 3]);
    p.step(1);
    expect([p.status, p.cursor]).toEqual(["ended", 3]);
    p.step(-1);
    expect([p.status, p.cursor]).toEqual(["paused", 2]);
  });

  it("clamps seeks and ignores a no-op seek on an untouched trace", () => {
    const p = new Playback(4);
    p.seek(0);
    expect(p.status).toBe("idle");
    p.seek(99);
    expect([p.status, p.cursor]).toEqual(["ended", 3]);
    p.seek(-5);
    expect([p.status, p.cursor]).toEqual(["paused", 0]);
    p.seek(1.7);
    expect(p.cursor).toBe(1);
  });

  it("seeking while playing pauses, even on the current step", () => {
    const p = new Playback(4);
    p.play();
    p.seek(0);
    expect([p.status, p.cursor]).toEqual(["paused", 0]);
  });

  it("resets to idle at the first step", () => {
    const p = new Playback(4);
    p.seek(2);
    p.reset();
    expect([p.status, p.cursor]).toEqual(["idle", 0]);
  });

  it("derives the tick interval from the speed", () => {
    const p = new Playback(2);
    p.setSpeed(4);
    expect(p.interval).toBe(BASE_INTERVAL_MS / 4);
  });

  it("keeps the spec's transitions and the cursor bounds under any sequence of operations", () => {
    // A small deterministic generator, so a failure is reproducible.
    let seed = 42;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 50; run++) {
      const p = new Playback(1 + next(6));
      for (let i = 0; i < 60; i++) {
        const before = p.status;
        const op = next(8);
        if (op === 0) p.play();
        else if (op === 1) p.pause();
        else if (op === 2) p.toggle();
        else if (op === 3 || op === 4) p.tick();
        else if (op === 5) p.step(next(3) - 1);
        else if (op === 6) p.seek(next(p.last + 3) - 1);
        else p.reset();
        if (p.status !== before) expect(ALLOWED[before]).toContain(p.status);
        expectBounds(p);
      }
    }
  });
});
