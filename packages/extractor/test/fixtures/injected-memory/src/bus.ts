export interface EventBus {
  publish(topic: string): void;
}

export const bus: EventBus = {
  publish(topic) {
    void topic;
  },
};

/** A second bus of the same type: binding both makes an `EventBus` receiver ambiguous. */
export const auditBus: EventBus = {
  publish(topic) {
    void topic;
  },
};
