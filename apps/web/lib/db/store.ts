// ============================================================
// Unified store factory (Phase 7-B Step 7)
// ============================================================
// Returns Postgres-backed adapters when DATABASE_URL is set, and
// in-memory / file-backed fallbacks otherwise. Cached at module
// scope so each warm container reuses the same connection pool.
// ============================================================

import {
    InMemoryProfileStore,
    InMemorySessionStore,
    FileBackedSessionStore,
    type ProfileStore,
    type SessionStore,
    type Cohort,
    userInCohort as userInCohortInMemory,
} from "@nyupath/engine";
import { getDb } from "./client.js";
import { PostgresSessionStore } from "./sessionStorePostgres.js";
import { PostgresProfileStore } from "./profileStorePostgres.js";
import { PostgresCohortStore } from "./cohortStorePostgres.js";

interface StoreBundle {
    sessionStore: SessionStore;
    profileStore: ProfileStore;
    cohortLookup: (userId: string) => Promise<Cohort>;
}

let cached: StoreBundle | null = null;

export function getStores(env: Record<string, string | undefined> = process.env): StoreBundle {
    if (cached) return cached;

    const db = getDb(env);
    if (db) {
        const cohortStore = new PostgresCohortStore(db);
        cached = {
            sessionStore: new PostgresSessionStore(db),
            profileStore: new PostgresProfileStore(db),
            cohortLookup: async (userId) => {
                const persisted = await cohortStore.lookup(userId);
                // DB hit wins; otherwise fall through to the engine's
                // in-memory overrides + default. This lets ops set a
                // process-wide default via setCohortAssignment without
                // needing a row per anonymous user.
                return persisted ?? userInCohortInMemory(userId);
            },
        };
        return cached;
    }

    const sessionStore: SessionStore = env.NYUPATH_SESSION_STORE_PATH
        ? new FileBackedSessionStore(env.NYUPATH_SESSION_STORE_PATH)
        : new InMemorySessionStore();

    cached = {
        sessionStore,
        profileStore: new InMemoryProfileStore(),
        cohortLookup: async (userId) => userInCohortInMemory(userId),
    };
    return cached;
}

/** Test-only: drop the cached bundle so the next getStores() rebuilds. */
export function resetStoresForTests(): void {
    cached = null;
}
