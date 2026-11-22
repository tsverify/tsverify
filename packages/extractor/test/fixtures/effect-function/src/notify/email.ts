/** A notifier exported as bare functions, not as an object with methods. */
const sent: string[] = [];

export async function sendMail(to: string, template: string): Promise<void> {
  sent.push(`${to}:${template}`);
}

export const sendSms = async (to: string): Promise<void> => {
  sent.push(to);
};
