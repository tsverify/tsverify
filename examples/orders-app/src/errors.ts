import type { OrderStatus } from "./orders/order";

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
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
