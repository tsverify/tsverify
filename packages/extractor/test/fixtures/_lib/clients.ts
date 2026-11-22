/** Fake SDK clients. The extractor must never descend into these bodies. */
const recorded: string[] = [];

export const ledger = {
  async record(entry: string): Promise<void> {
    recorded.push(entry);
  },
};

export const stripe = {
  refunds: {
    async create(params: { charge: string }): Promise<{ id: string }> {
      await ledger.record(`refund ${params.charge}`);
      return { id: `re_${params.charge}` };
    },
  },
};

export const email = {
  async send(message: { to: string; template: string }): Promise<void> {
    recorded.push(message.to);
  },
};

export const audit = {
  async log(line: string): Promise<void> {
    recorded.push(line);
  },
};
