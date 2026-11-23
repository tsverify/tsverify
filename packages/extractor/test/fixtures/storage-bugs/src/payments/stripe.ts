export const stripe = {
  refunds: {
    async create(_params: { charge: string }): Promise<{ id: string }> {
      return { id: "re_1" };
    },
  },
};
