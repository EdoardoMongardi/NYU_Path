// ============================================================
// getCatalog() loads the engine catalog into the session
// ============================================================
// Pins the wiring: the chat route populates session.courses /
// session.prereqs from getCatalog(), so the forward planner has
// the catalog in production.

import { describe, expect, it } from "vitest";
import { getCatalog, _clearCatalogCache } from "../lib/loadCatalog";

describe("getCatalog", () => {
    it("loads non-empty courses and prereqs", () => {
        _clearCatalogCache();
        const cat = getCatalog();
        expect(cat.courses.length).toBeGreaterThan(0);
        expect(cat.prereqs.length).toBeGreaterThan(0);
    });

    it("caches: a second call returns the same instance", () => {
        _clearCatalogCache();
        const first = getCatalog();
        const second = getCatalog();
        expect(second).toBe(first);
    });
});
