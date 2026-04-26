// ============================================================
// DataLoader — Group 5 unit tests (Phase 1 §11.0 + §11.2)
// ============================================================
// Covers:
//   - loadSchoolConfig: real CAS fixture loads + _meta passes
//   - loadSchoolConfigStrict: not_found, parse_error, invalid_meta paths
//   - resolveProgramFile: exact > earlier_snapshot > current_fallback > not_found
//   - applicableCatalogYear: declaredUnder > readmission > matriculation
//
// Synthetic fixtures live under an OS tmpdir so the live `data/` tree
// is never modified by the test run.
// ============================================================

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    loadSchoolConfig,
    loadSchoolConfigStrict,
    resolveProgramFile,
    applicableCatalogYear,
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
        expect(cfg!.totalCreditsRequired).toBe(128);
        expect(cfg!.residency.type).toBe("suffix_based");
        expect(cfg!.residency.minCredits).toBe(64);
        expect(cfg!.passFail?.careerLimit).toBe(32);
        expect(cfg!.spsPolicy?.allowed).toBe(true);
        expect(cfg!.doubleCounting?.defaultMajorToMajor).toBe(2);
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

// ============================================================
// resolveProgramFile — precedence rule (§11.0.3)
// ============================================================
describe("resolveProgramFile — catalog-year precedence", () => {
    let tmpRoot: string;
    let programsDir: string;
    let schoolDir: string;
    let logEvents: Array<{ kind: string }>;
    const logger = (e: { kind: string }) => {
        logEvents.push(e);
    };

    beforeAll(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), "nyupath-resolve-"));
        programsDir = join(tmpRoot, "programs");
        schoolDir = join(programsDir, "cas");
        mkdirSync(schoolDir, { recursive: true });
        // current file
        writeFileSync(join(schoolDir, "demo.json"), "{}", "utf-8");
        // 2023-2024 snapshot
        writeFileSync(join(schoolDir, "demo__2023-2024.json"), "{}", "utf-8");
        // 2025-2026 snapshot (exact match for one of the cases)
        writeFileSync(join(schoolDir, "demo__2025-2026.json"), "{}", "utf-8");
    });

    afterAll(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    beforeAll(() => {
        logEvents = [];
    });

    it("returns kind=exact when the requested catalog year file exists", () => {
        logEvents = [];
        const r = resolveProgramFile("cas", "demo", "2025-2026", { programsDir, logger });
        expect(r.kind).toBe("exact");
        if (r.kind !== "exact") return;
        expect(r.catalogYear).toBe("2025-2026");
        expect(r.path.endsWith("demo__2025-2026.json")).toBe(true);
        // exact matches must NOT log a fallback event
        expect(logEvents.filter(e => e.kind === "catalog_year_fallback")).toHaveLength(0);
    });

    it("falls back to the nearest earlier snapshot when no exact match exists", () => {
        logEvents = [];
        const r = resolveProgramFile("cas", "demo", "2024-2025", { programsDir, logger });
        expect(r.kind).toBe("earlier_snapshot");
        if (r.kind !== "earlier_snapshot") return;
        expect(r.catalogYear).toBe("2023-2024");
        expect(r.requested).toBe("2024-2025");
        expect(logEvents.some(e => e.kind === "catalog_year_fallback")).toBe(true);
    });

    it("falls back to the unsuffixed current file when no earlier snapshot exists", () => {
        logEvents = [];
        // 2022-2023 is older than every snapshot we wrote — no earlier file qualifies
        const r = resolveProgramFile("cas", "demo", "2022-2023", { programsDir, logger });
        expect(r.kind).toBe("current_fallback");
        if (r.kind !== "current_fallback") return;
        expect(r.path.endsWith("/demo.json")).toBe(true);
        expect(logEvents.some(e => e.kind === "catalog_year_fallback")).toBe(true);
    });

    it("returns not_found when neither snapshots nor current file exist", () => {
        logEvents = [];
        const r = resolveProgramFile("cas", "ghost", "2025-2026", { programsDir, logger });
        expect(r.kind).toBe("not_found");
        if (r.kind !== "not_found") return;
        expect(r.programId).toBe("ghost");
        expect(logEvents.some(e => e.kind === "catalog_year_not_found")).toBe(true);
    });

    it("returns not_found when the school directory itself is missing", () => {
        logEvents = [];
        const r = resolveProgramFile("nonexistent_school", "demo", "2025-2026", {
            programsDir,
            logger,
        });
        expect(r.kind).toBe("not_found");
    });

    it("rejects malformed catalogYear input", () => {
        expect(() =>
            resolveProgramFile("cas", "demo", "2025", { programsDir, logger })
        ).toThrow(/invalid catalogYear/);
    });
});

// ============================================================
// applicableCatalogYear — readmission + per-program override
// ============================================================
describe("applicableCatalogYear — precedence (§11.0.3)", () => {
    it("defaults to matriculation year", () => {
        expect(
            applicableCatalogYear({ matriculationCatalogYear: "2024-2025" })
        ).toBe("2024-2025");
    });

    it("readmission year wins over matriculation (G40)", () => {
        expect(
            applicableCatalogYear({
                matriculationCatalogYear: "2020-2021",
                readmissionCatalogYear: "2025-2026",
            })
        ).toBe("2025-2026");
    });

    it("declaredUnderCatalogYear (per-program) wins over both", () => {
        expect(
            applicableCatalogYear({
                matriculationCatalogYear: "2020-2021",
                readmissionCatalogYear: "2025-2026",
                declaredUnderCatalogYear: "2024-2025",
            })
        ).toBe("2024-2025");
    });
});
