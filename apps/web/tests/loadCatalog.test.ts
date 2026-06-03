// ============================================================
// Phase A — getCatalog() loads the engine catalog into the session
// ============================================================
// Pins the wiring fix: the chat route now populates
// session.programs/courses/prereqs from getCatalog(), so check_overlap
// + any rule-engine path are no longer dead in production.

import { describe, expect, it } from "vitest";
import { getCatalog, _clearCatalogCache } from "../lib/loadCatalog";

describe("getCatalog (Phase A)", () => {
    it("loads non-empty courses, prereqs, and a programs map", () => {
        _clearCatalogCache();
        const cat = getCatalog();
        expect(cat.courses.length).toBeGreaterThan(0);
        expect(cat.prereqs.length).toBeGreaterThan(0);
        expect(cat.programs.size).toBeGreaterThan(0);
    });

    it("keys programs by programId", () => {
        const cat = getCatalog();
        for (const [key, program] of cat.programs) {
            expect(key).toBe(program.programId);
        }
    });

    it("caches: a second call returns the same instance", () => {
        _clearCatalogCache();
        const first = getCatalog();
        const second = getCatalog();
        expect(second).toBe(first);
    });
});
