import { orderModel } from "@tsverify/ir/testing";
import { summarize } from "@tsverify/render";
import { describe, expect, it } from "vitest";
import {
  codeAnyStateModel,
  escapingModel,
  nonAtomicRefundModel,
  ownerOrAdminModel,
} from "./models";

describe("summarize", () => {
  it("summarizes the Order model", async () => {
    const out = summarize(orderModel());
    expect(out).toContain(
      "- **refund**: an admin (requires role(admin)) can move a paid order to refunded. " +
        "This issues stripe.refund exactly once and is atomic.\n",
    );
    await expect(out).toMatchFileSnapshot("__golden__/order-summary.md");
  });

  it("reads a multi-actor by as alternatives, with the transition's requires stated once", async () => {
    const out = summarize(ownerOrAdminModel());
    expect(out).toContain(
      "- **refund**: a customer (untrusted, requires owner) or an admin (requires role(admin)) " +
        "can move a paid order to refunded. Whoever acts must also pass verified. " +
        "This issues stripe.refund exactly once and is atomic.\n",
    );
    await expect(out).toMatchFileSnapshot("__golden__/owner-or-admin-summary.md");
  });

  it("does not call an untrusted alternative unguarded when the transition has guards", () => {
    const model = ownerOrAdminModel();
    const customer = model.actors.customer;
    if (customer) customer.requires = [];
    expect(summarize(model)).toContain(
      "a customer (untrusted) or an admin (requires role(admin)) can move a paid order to refunded. Whoever acts must also pass verified.",
    );
  });

  it("is deterministic", () => {
    const model = orderModel();
    const shuffled = { ...model, transitions: [...model.transitions].reverse() };
    expect(summarize(shuffled)).toBe(summarize(model));
  });

  it("warns about a non-atomic exactly-once effect", () => {
    expect(summarize(nonAtomicRefundModel())).toContain(
      "This issues stripe.refund exactly once and is not atomic. ⚠ The state check and the write " +
        "are separate steps, so concurrent runs could issue stripe.refund more than once.",
    );
  });

  it("describes code models and unconstrained source states", () => {
    const out = summarize(codeAnyStateModel());
    expect(out).toContain("This model was extracted from the code.");
    expect(out).toContain("can move an order in any state to refunded.");
  });

  it("flags an unguarded untrusted actor", () => {
    const model = orderModel();
    const checkout = model.transitions.find((t) => t.name === "checkout");
    if (!checkout) throw new Error("fixture changed");
    checkout.requires = [];
    expect(summarize(model)).toContain("a customer (untrusted, no guard) can move a draft order");
  });

  it("reads nested rule expressions and escapes Markdown", () => {
    const out = summarize(escapingModel());
    expect(out).toContain("A support ticket has 4 states: open, on-hold, on_hold and end.");
    expect(out).toContain(
      "Always: if the support ticket is end, then pager{duty} has happened at most once.",
    );
    expect(out).toContain("\\<b\\>{urgent}\\</b\\>");
  });
});
