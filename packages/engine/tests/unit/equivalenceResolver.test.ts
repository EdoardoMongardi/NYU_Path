// ============================================================
// Unit Tests — Equivalence Resolver
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Course } from "@nyupath/shared";
import { EquivalenceResolver } from "../../src/equivalence/equivalenceResolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../src/data");

const courses: Course[] = JSON.parse(
    readFileSync(join(DATA_DIR, "courses.json"), "utf-8")
);

describe("EquivalenceResolver", () => {
    const resolver = new EquivalenceResolver(courses);

    it("resolves cross-listed courses to same canonical", () => {
        const canonical471 = resolver.getCanonical("CSCI-UA 471");
        const canonical301 = resolver.getCanonical("DS-UA 301");
        expect(canonical471).toBe(canonical301);
    });

    it("areCrossListed returns true for cross-listed pair", () => {
        expect(resolver.areCrossListed("CSCI-UA 471", "DS-UA 301")).toBe(true);
    });

    it("areCrossListed returns false for non-cross-listed courses", () => {
        expect(resolver.areCrossListed("CSCI-UA 101", "CSCI-UA 102")).toBe(false);
    });

    it("areExclusive detects mutually exclusive courses", () => {
        expect(resolver.areExclusive("CSCI-UA 101", "CSCI-UA 110")).toBe(true);
        expect(resolver.areExclusive("CSCI-UA 110", "CSCI-UA 101")).toBe(true);
    });

    it("normalizeCompleted deduplicates cross-listed courses", () => {
        const { normalized, warnings } = resolver.normalizeCompleted([
            "CSCI-UA 471",
            "DS-UA 301",
        ]);
        // Only one should remain
        expect(normalized.size).toBe(1);
        expect(warnings.some((w) => w.includes("cross-listed"))).toBe(true);
    });

    it("normalizeCompleted flags exclusive courses", () => {
        const { normalized, warnings } = resolver.normalizeCompleted([
            "CSCI-UA 101",
            "CSCI-UA 110",
        ]);
        // Both remain but with a warning
        expect(normalized.size).toBe(2);
        expect(warnings.some((w) => w.includes("mutually exclusive"))).toBe(true);
    });

    it("isInSet matches cross-listed equivalents", () => {
        const courseSet = new Set(["DS-UA 301"]);
        expect(resolver.isInSet("CSCI-UA 471", courseSet)).toBe(true);
    });

    it("isInSet does not match unrelated courses", () => {
        const courseSet = new Set(["CSCI-UA 101"]);
        expect(resolver.isInSet("CSCI-UA 102", courseSet)).toBe(false);
    });
});
