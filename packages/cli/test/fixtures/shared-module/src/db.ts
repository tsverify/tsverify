import type { Parcel } from "./parcel";

export interface ParcelRepository {
  get(id: string): Promise<Parcel>;
  save(parcel: Parcel): Promise<void>;
}

export interface Transaction {
  readonly parcels: ParcelRepository;
}

export interface Database extends Transaction {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

const rows = new Map<string, Parcel>();

const parcels: ParcelRepository = {
  async get(id) {
    const parcel = rows.get(id);
    if (parcel === undefined) throw new Error(`parcel ${id} not found`);
    return { ...parcel };
  },
  async save(parcel) {
    rows.set(parcel.id, { ...parcel });
  },
};

/** In-memory parcels; transactions are not isolated (generated tests replace this client). */
export const db: Database = {
  parcels,
  async transaction(fn) {
    return fn({ parcels });
  },
};
