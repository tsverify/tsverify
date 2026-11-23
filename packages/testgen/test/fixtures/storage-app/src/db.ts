let tail: Promise<unknown> = Promise.resolve();

/** Runs `fn` as one indivisible step: one at a time, in call order. */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.catch(() => undefined);
  return run;
}
