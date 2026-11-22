/**
 * Counterexample playback: a step cursor over a trace plus a play/pause status. Specified in
 * `playback.behavior.yaml`; each status change lives in its own method (`play`, `pause`, `tick`,
 * `hold`, `arrive`, `reset`), so `tsv check packages/viewer/src` can compare the two.
 *
 * Pure: no timers and no DOM. The UI calls `tick()` from its own interval while `status` is
 * `playing`, and re-renders after every call.
 */
export type PlaybackStatus = "idle" | "playing" | "paused" | "ended";

/** Playback speeds offered by the UI, as multiples of one step per second. */
export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** Milliseconds between clock ticks at speed 1. */
export const BASE_INTERVAL_MS = 1000;

export class Playback {
  status: PlaybackStatus;
  /** Index into the trace's steps, 0 … `last`. */
  cursor: number;
  speed: Speed;
  /** Index of the last step (the violating one). */
  readonly last: number;

  /** `steps` is the trace length; a trace always has at least its initial state. */
  constructor(steps: number) {
    if (!Number.isSafeInteger(steps) || steps < 1) {
      throw new Error(`a trace has at least one step (got ${steps})`);
    }
    this.last = steps - 1;
    this.cursor = 0;
    this.speed = 1;
    this.status = "idle";
  }

  /** Milliseconds between ticks at the current speed. */
  get interval(): number {
    return BASE_INTERVAL_MS / this.speed;
  }

  /** Start the clock. From `ended`, playback restarts at the first step. */
  play(): void {
    if (this.status === "playing") return;
    if (this.status === "ended") this.cursor = 0;
    this.status = "playing";
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.status = "paused";
  }

  toggle(): void {
    if (this.status === "playing") this.pause();
    else this.play();
  }

  /** One clock tick: advance a playing trace by one step, ending on the last one. */
  tick(): void {
    if (this.status !== "playing") return;
    if (this.cursor < this.last) this.cursor += 1;
    if (this.cursor < this.last) return;
    this.status = "ended";
  }

  /** Move the cursor by `delta` steps (keyboard and step buttons). */
  step(delta: number): void {
    this.seek(this.cursor + delta);
  }

  /**
   * Jump to step `index` (clamped). Moving by hand stops the clock: the last step ends the
   * playback, any other step pauses it. Seeking to step 0 of an untouched trace changes nothing.
   */
  seek(index: number): void {
    const target = Math.min(this.last, Math.max(0, Math.trunc(index)));
    if (target === this.cursor && this.status !== "playing") return;
    this.cursor = target;
    if (target === this.last) this.arrive();
    else this.hold();
  }

  /** Back to the first step, clock stopped. */
  reset(): void {
    if (this.status === "idle") return;
    this.cursor = 0;
    this.status = "idle";
  }

  setSpeed(speed: Speed): void {
    this.speed = speed;
  }

  /** The cursor reached the last step by hand. */
  private arrive(): void {
    if (this.status === "ended") return;
    this.status = "ended";
  }

  /** The cursor moved by hand to a step other than the last one. */
  private hold(): void {
    if (this.status === "paused") return;
    this.status = "paused";
  }
}
