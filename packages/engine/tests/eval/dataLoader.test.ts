// ============================================================
// DataLoader — Group 5 unit tests (Phase 1 §11.0 + §11.2)
// ============================================================
// Covers:
//   - loadSchoolConfig: real CAS fixture loads + _meta passes
//   - loadSchoolConfigStrict: not_found, parse_error, invalid_meta paths
//
// Synthetic fixtures live under an OS tmpdir so the live `data/` tree
// is never modified by the test run.
// ============================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    loadSchoolConfig,
    loadSchoolConfigStrict,
} from "../../src/dataLoader.js";

// ---- helpers ----

function writeJson(path: string, body: unknown): void {
    writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
}

const VALID_META = {
    catalogYear: "2025-2026",
    sourceUrl: "https://bulletin.cas.nyu.edu/undergraduate/academic-policies/",
    lastVerified: "2026-04-26",
    sourceHash: "sha256:" + "a".repeat(64),
    extractedBy: "manual",
    verifiedBy: "hand-review",
} as const;

// ============================================================
// loadSchoolConfig — real CAS fixture
// ============================================================
describe("loadSchoolConfig — real CAS fixture", () => {
    it("loads data/schools/cas.json and exposes the SchoolConfig", () => {
        const cfg = loadSchoolConfig("cas");
        expect(cfg).not.toBeNull();
        expect(cfg!.schoolId).toBe("cas");
        expect(cfg!.courseSuffix).toEqual(["-UA"]);
        expect(cfg!.residency.type).toBe("suffix_based");
        expect(cfg!.residency.suffix).toBe("-UA");
        expect(cfg!.passFail?.careerLimitType).toBe("credits");
        expect(cfg!.spsPolicy?.allowed).toBe(true);
    });

    it("strict loader exposes the validated _meta block", () => {
        const result = loadSchoolConfigStrict("cas");
        expect(result.ok).toBe(true);
        if (!result.ok) return; // narrow for TS
        expect(result.meta.catalogYear).toBe("2025-2026");
        expect(result.meta.extractedBy).toBe("manual");
        expect(result.meta.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("returns null and warns for an unknown schoolId", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const cfg = loadSchoolConfig("does_not_exist_xyz");
            expect(cfg).toBeNull();
            expect(warn).toHaveBeenCalled();
            const payload = warn.mock.calls[0]![1] as string;
            expect(payload).toContain("school_config_load_failed");
            expect(payload).toContain("not_found");
        } finally {
            warn.mockRestore();
        }
    });
});

// ============================================================
// loadSchoolConfigStrict — synthetic fixtures
// ============================================================
describe("loadSchoolConfigStrict — synthetic fixtures", () => {
    let tmpRoot: string;

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), "nyupath-dataloader-"));
    });

    afterAll(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("returns not_found when the file is missing", () => {
        const result = loadSchoolConfigStrict("missing", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("not_found");
        expect(result.path.endsWith("missing.json")).toBe(true);
    });

    it("returns parse_error for malformed JSON", () => {
        const path = join(tmpRoot, "broken.json");
        writeFileSync(path, "{ this is not json", "utf-8");
        const result = loadSchoolConfigStrict("broken", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("parse_error");
    });

    it("returns invalid_meta when _meta is missing", () => {
        const path = join(tmpRoot, "no_meta.json");
        writeJson(path, { schoolId: "no_meta", name: "No Meta" });
        const result = loadSchoolConfigStrict("no_meta", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("invalid_meta");
        expect(result.errors.join("\n")).toContain("_meta");
    });

    it("returns invalid_meta when sourceHash is malformed", () => {
        const path = join(tmpRoot, "bad_hash.json");
        writeJson(path, {
            _meta: { ...VALID_META, sourceHash: "md5:abcd" },
            schoolId: "bad_hash",
        });
        const result = loadSchoolConfigStrict("bad_hash", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("invalid_meta");
        expect(result.errors.join("\n")).toContain("sourceHash");
    });

    it("returns invalid_meta when catalogYear's second year is not first+1", () => {
        const path = join(tmpRoot, "bad_year.json");
        writeJson(path, {
            _meta: { ...VALID_META, catalogYear: "2025-2027" },
            schoolId: "bad_year",
        });
        const result = loadSchoolConfigStrict("bad_year", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("invalid_meta");
    });

    it("strips _meta from the body so the returned config matches SchoolConfig shape", () => {
        const path = join(tmpRoot, "ok.json");
        writeJson(path, {
            _meta: VALID_META,
            schoolId: "ok",
            name: "OK School",
            degreeType: "BS",
            courseSuffix: ["-UX"],
            totalCreditsRequired: 120,
            overallGpaMin: 2.0,
            residency: { type: "total_nyu_credits", minCredits: 56 },
            acceptsTransferCredit: true,
        });
        const result = loadSchoolConfigStrict("ok", { schoolsDir: tmpRoot });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // _meta must NOT leak into the SchoolConfig body
        expect((result.config as unknown as Record<string, unknown>)._meta).toBeUndefined();
        expect(result.config.schoolId).toBe("ok");
        expect(result.config.residency.type).toBe("total_nyu_credits");
        expect(result.meta.catalogYear).toBe(VALID_META.catalogYear);
    });
});
