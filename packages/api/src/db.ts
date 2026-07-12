import { PrismaClient } from "@nexus-scheduler/shared/prisma";

// Single Prisma client instance for the process — Prisma manages its own
// connection pool internally, so this should not be re-instantiated per
// request.
export const prisma: PrismaClient = new PrismaClient();
