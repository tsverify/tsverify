export interface Parcel {
  id: string;
  ownerId: string;
  status: "packed" | "shipped";
}

export interface Actor {
  id: string;
}
