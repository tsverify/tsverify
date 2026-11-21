/**
 * Simulated network latency for the fake clients: a few microtask ticks, so concurrent callers
 * interleave around a remote call the way they would against the real service.
 */
export async function roundTrip(ticks = 3): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    await Promise.resolve();
  }
}
