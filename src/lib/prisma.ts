import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// Lazy singleton — Prisma 7 requires an adapter at construction time.
// We construct on first access so pages can render their "DB not connected"
// states when DATABASE_URL is unset (instead of crashing at module import).

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function makeClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in your Postgres connection.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!globalForPrisma.prisma) {
      globalForPrisma.prisma = makeClient();
    }
    return Reflect.get(globalForPrisma.prisma, prop, globalForPrisma.prisma);
  },
});

// Transaction client subset — the type Prisma hands to a $transaction
// callback. Includes the model accessors and $execute / $query helpers
// but excludes $transaction / $connect / lifecycle methods.
type TxClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Runs `fn` inside a transaction with `xsystem.actor_uuid` set as a
 * session-local GUC, so the audit-log triggers
 * (prisma/migrations-manual/02_audit_log_triggers.sql) record the actor.
 * Pass `null` when there is no user (cron jobs, system tasks) — the audit
 * row still writes, just with a NULL actor.
 *
 * The callback receives a transaction client; mutations done via the
 * outer `prisma` global won't see the SET LOCAL because they run on a
 * different connection.
 */
export async function withActor<T>(
  actorId: string | null,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // UUID format check is defence-in-depth against SQL injection via the
    // raw SET LOCAL statement. Reject anything that isn't a canonical UUID.
    if (actorId && UUID_RE.test(actorId)) {
      await tx.$executeRawUnsafe(`SET LOCAL xsystem.actor_uuid = '${actorId}'`);
    }
    return fn(tx);
  });
}
