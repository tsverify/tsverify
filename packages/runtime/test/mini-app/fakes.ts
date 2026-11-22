// The instrument configs for the mini-app, as testgen would derive them from its CodeSites.
import { instrument, type Scheduler } from "../../src/index";

export function miniAppFakes(s: Scheduler) {
  const db = instrument.store(s, {
    client: "db",
    collections: { orders: { key: "id" } },
    read: ["orders.get"],
    commit: ["orders.save"],
    transaction: "transaction",
  });
  const stripe = instrument.effects(s, { client: "stripe", calls: ["refunds.create"] });
  return { db, stripe };
}
