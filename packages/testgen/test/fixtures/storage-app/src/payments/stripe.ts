export const stripe = {
  refunds: {
    async create(_params: { charge: string }): Promise<{ id: string }> {
      throw new Error("the real payment provider is not reachable from tests");
    },
  },
};
