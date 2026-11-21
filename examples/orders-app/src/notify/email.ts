import { roundTrip } from "../fakes/round-trip";

export type EmailTemplate = "receipt";

export interface EmailMessage {
  to: string;
  template: EmailTemplate;
}

const outbox: EmailMessage[] = [];

/** In-memory fake email client. */
export const email = {
  async send(message: EmailMessage): Promise<void> {
    outbox.push({ ...message });
    await roundTrip();
  },
};

/** Inspection and reset for tests. */
export const emailFake = {
  /** Every message sent since the last reset, in call order. */
  sent(): EmailMessage[] {
    return outbox.map((message) => ({ ...message }));
  },
  reset(): void {
    outbox.length = 0;
  },
};
