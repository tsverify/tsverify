import { describe, expect, test } from "vitest";
import { scheduler } from "../scheduler";
import { effects } from "./effects";
import { UninstrumentedCallError } from "./strict";

describe("instrument.effects", () => {
  test("builds nested methods from call paths and records every call", async () => {
    const s = scheduler();
    const stripe = effects(s, {
      client: "stripe",
      calls: ["refunds.create", "charges.capture", "webhooks.endpoints.list"],
    });
    expect(s.knownGates()).toEqual([
      "stripe.refunds.create",
      "stripe.charges.capture",
      "stripe.webhooks.endpoints.list",
    ]);
    expect(await stripe.client.refunds.create({ charge: "ch_1" })).toEqual({
      id: "refunds_create_fake_1",
    });
    expect(await stripe.client.refunds.create({ charge: "ch_2" })).toEqual({
      id: "refunds_create_fake_2",
    });
    await stripe.client.webhooks.endpoints.list();
    expect(stripe.calls("refunds.create")).toEqual([
      { seq: 0, worker: null, effect: "stripe.refunds.create", args: [{ charge: "ch_1" }] },
      { seq: 1, worker: null, effect: "stripe.refunds.create", args: [{ charge: "ch_2" }] },
    ]);
    expect(s.effects().map((e) => e.effect)).toEqual([
      "stripe.refunds.create",
      "stripe.refunds.create",
      "stripe.webhooks.endpoints.list",
    ]);
  });

  test('path "" makes the client itself the recording function, gated by the client name', async () => {
    const s = scheduler();
    const email = effects(s, { client: "email", calls: ["", "batch.send"] });
    expect(s.knownGates()).toEqual(["email", "email.batch.send"]);
    expect(typeof email.client).toBe("function");
    expect(await email.client("a@example.com", "welcome")).toEqual({ id: "email_fake_1" });
    await email.client.batch.send(["b@example.com"]);
    expect(email.calls("")).toEqual([
      { seq: 0, worker: null, effect: "email", args: ["a@example.com", "welcome"] },
    ]);
    expect(s.effects().map((e) => e.effect)).toEqual(["email", "email.batch.send"]);
    expect(() => (email.client as unknown as { other: () => void }).other()).toThrow(
      'email.other is not instrumented: the effects fake for client "email" only records email, email.batch.send.',
    );
    expect(() => effects(scheduler(), { client: "x", calls: ["", ""] })).toThrow(
      'effects fake "x": call path "" is listed twice',
    );
  });

  test("arguments are recorded as they were at call time; results come from `returns`", async () => {
    const s = scheduler();
    const email = effects(s, {
      client: "email",
      calls: ["send"],
      returns: { send: (args, n) => ({ messageId: `m${n}`, to: (args[0] as { to: string }).to }) },
    });
    const message = { to: "a@example.com" };
    expect(await email.client.send(message)).toEqual({ messageId: "m1", to: "a@example.com" });
    message.to = "changed";
    expect(email.calls("send")[0]?.args).toEqual([{ to: "a@example.com" }]);
  });

  test("worker ids are recorded, and counters restart on reset", async () => {
    const s = scheduler();
    const email = effects(s, { client: "email", calls: ["send"] });
    s.spawn("w1", () => email.client.send({ to: "x" }));
    await s.play([["w1", "until-done"]]);
    expect(email.calls("send").map((c) => c.worker)).toEqual(["w1"]);
    expect(s.outcome("w1")).toEqual({ status: "done", value: { id: "send_fake_1" } });
    s.reset();
    expect(email.calls("send")).toEqual([]);
    expect(await email.client.send({ to: "y" })).toEqual({ id: "send_fake_1" });
  });

  test("an unknown call throws, naming the path and the config to add", () => {
    const s = scheduler();
    const stripe = effects(s, { client: "stripe", calls: ["refunds.create"] });
    const client = stripe.client as unknown as Record<string, Record<string, () => unknown>>;
    expect(() => client.charges?.create?.()).toThrow(UninstrumentedCallError);
    expect(() => client.refunds?.cancel?.()).toThrowErrorMatchingInlineSnapshot(
      `[UninstrumentedCallError: stripe.refunds.cancel is not instrumented: the effects fake for client "stripe" only records stripe.refunds.create. If the code under test really calls it, add "refunds.cancel" to the fake's \`calls\` (and, if it is a spec effect, map the effect to it in \`bindings.effects\`).]`,
    );
  });

  test("conflicting or duplicate paths are config errors", () => {
    expect(() => effects(scheduler(), { client: "x", calls: ["a.b", "a.b"] })).toThrow(
      'effects fake "x": call path "a.b" is listed twice or conflicts',
    );
    expect(() => effects(scheduler(), { client: "x", calls: ["a", "a.b"] })).toThrow(
      'call path "a.b" conflicts with another path',
    );
    expect(() => effects(scheduler(), { client: "x", calls: ["a..b"] })).toThrow(
      'invalid call path "a..b"',
    );
  });
});
