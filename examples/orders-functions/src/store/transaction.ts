let last: Promise<void> = Promise.resolve();

/**
 * Runs `fn` with exclusive access: calls are serialized by a mutex, so a status check and the
 * save that depends on it cannot interleave with another `withTransaction`. Not reentrant.
 *
 * Reads and saves outside it do not take the mutex. The spec declares this function atomic
 * (`bindings.storage.atomic`); tsverify trusts that and does not check inside it.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = last;
  let release = (): void => {};
  last = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
