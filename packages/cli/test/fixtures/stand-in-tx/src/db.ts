/**
 * The database connection, opened as the module loads: like many apps, it needs a URL, and
 * falls back to a local one only under test (`NODE_ENV=test`, which `vitest` sets).
 */
export interface Tx {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
}

function connect(url: string | undefined): { url: string } {
  if (url === undefined) throw new Error("DATABASE_URL is not set");
  return { url };
}

export const connection = connect(
  process.env.DATABASE_URL ?? (process.env.NODE_ENV === "test" ? "memory://local" : undefined),
);

/** Runs `fn` in one transaction (generated tests replace it with a fake). */
export async function withTransaction<T>(
  _ctx: { actor: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return fn({
    async insert() {
      throw new Error(`no database at ${connection.url}`);
    },
  });
}
