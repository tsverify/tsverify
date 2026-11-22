import type { OrderStatus } from "./generated/prisma/client";

/**
 * A conditional update matched no row: the order left the expected state between the check and
 * the write (another request got there first).
 */
export class ConcurrentUpdateError extends Error {
  override readonly name = "ConcurrentUpdateError";

  constructor(transition: string, expected: OrderStatus) {
    super(`cannot ${transition}: the order is no longer ${expected}`);
  }
}

/** A guard rejected the actor. */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}

/** The order is not in a state the transition may start from. */
export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  readonly transition: string;
  readonly status: OrderStatus;

  constructor(transition: string, status: OrderStatus) {
    super(`cannot ${transition} an order that is ${status}`);
    this.transition = transition;
    this.status = status;
  }
}
