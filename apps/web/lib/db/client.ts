// ============================================================
// Drizzle + Neon serverless client (Phase 7-B Step 7)
// ============================================================
// Lazy-initialized at module level. The chat route + tools call
// `getDb()` whenever they need the database; if `DATABASE_URL` is
// not set the function returns `null` and callers fall back to the
// in-memory / file-backed defaults.
//
// Neon's serverless driver supports both a connection-pool TCP path
// (when used from a long-lived Node server) and a single-shot WebSocket
// path (when used from Vercel edge functions). Our v2 route runs on
// the Node runtime (per `runtime = "nodejs"` in route.ts) so we use
// the standard `drizzle-orm/neon-serverless` adapter with the Pool API.
// ============================================================

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema.js";
import ws from "ws";

// Required when running outside the Vercel edge runtime — the Neon
// serverless driver opens WebSocket connections under the hood and
// needs a `ws` polyfill in plain Node.
neonConfig.webSocketConstructor = ws;

let cachedDb: NeonDatabase<typeof schema> | null = null;
let cachedPool: Pool | null = null;
let cachedAt: string | null = null;

export type Database = NeonDatabase<typeof schema>;

export function getDb(env: Record<string, string | undefined> = process.env): Database | null {
    if (cachedDb) return cachedDb;
    const url = env.DATABASE_URL;
    if (!url) return null;
    cachedPool = new Pool({ connectionString: url });
    cachedDb = drizzle(cachedPool, { schema });
    cachedAt = new Date().toISOString();
    return cachedDb;
}

/** Test-only: tear the connection pool down between fixtures. */
export async function closeDb(): Promise<void> {
    if (cachedPool) {
        await cachedPool.end();
        cachedPool = null;
        cachedDb = null;
        cachedAt = null;
    }
}

/** Lightweight introspection — used by ops + tests. */
export function getDbStatus(): { connected: boolean; cachedAt: string | null } {
    return { connected: cachedDb !== null, cachedAt };
}

export { schema };
