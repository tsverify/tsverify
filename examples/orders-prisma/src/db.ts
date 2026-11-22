import { PrismaClient } from "./generated/prisma/client";

/** The app's one database client (`bindings.clients.prisma` in the behavior file). */
export const prisma = new PrismaClient();
