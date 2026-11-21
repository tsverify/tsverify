// Stand-in for the Stripe SDK client. Plain application code: no test hooks.

export interface RefundParams {
  charge: string;
  amount?: number;
  metadata?: Record<string, string>;
}

let seq = 0;

export const stripe = {
  refunds: {
    async create(params: RefundParams): Promise<{ id: string; charge: string }> {
      await new Promise((resolve) => setImmediate(resolve)); // network round trip
      seq += 1;
      return { id: `re_${seq}`, charge: params.charge };
    },
  },
};
