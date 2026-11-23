import { shippedTemplate } from "@acme/templates";
import { db } from "./db";
import type { Actor } from "./parcel";
import { requireOwner, sendMail } from "./services";

/** The owner ships a packed parcel, then gets an email. */
export async function shipParcel(ctx: { actor: Actor }, parcelId: string): Promise<void> {
  const ownerId = await db.transaction(async (tx) => {
    const parcel = await tx.parcels.get(parcelId);
    requireOwner(ctx.actor, parcel);
    if (parcel.status !== "packed") throw new Error(`parcel ${parcel.id} is ${parcel.status}`);
    parcel.status = "shipped";
    await tx.parcels.save(parcel);
    return parcel.ownerId;
  });
  await sendMail(ownerId, shippedTemplate());
}
