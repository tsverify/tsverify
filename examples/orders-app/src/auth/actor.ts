export type Role = "admin";

/** Whoever is calling: a signed-in customer or a staff member. */
export interface Actor {
  id: string;
  roles: readonly Role[];
}
