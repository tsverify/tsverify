import { roundTrip } from "../fakes/round-trip";

export interface RefundParams {
  charge: string;
}

export interface Refund {
  id: string;
  charge: string;
}

const refunds: Refund[] = [];

/** In-memory fake of the subset of the Stripe SDK the app uses. */
export const stripe = {
  refunds: {
    async create(params: RefundParams): Promise<Refund> {
      const refund = { id: `re_${refunds.length + 1}`, charge: params.charge };
      refunds.push(refund);
      await roundTrip();
      return { ...refund };
    },
  },
};

/** Inspection and reset for tests. */
export const stripeFake = {
  /** Every refund created since the last reset, in call order. */
  refunds(): Refund[] {
    return refunds.map((refund) => ({ ...refund }));
  },
  reset(): void {
    refunds.length = 0;
  },
};
