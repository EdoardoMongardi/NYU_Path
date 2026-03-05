// ============================================================
// Week 1 — Expanded Deterministic Tests (Phase 2)
// Covers: CAS Core audit, math substitution limits, double-count,
//         transfer credit caps, AP/IB equivalencies
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudentProfile, Program, Course } from "@nyupath/shared";
import { degreeAudit } from "../../src/audit/degreeAudit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, "profiles");
const DATA_DIR = join(__dirname, "../../src/data");

const courses: Course[] = JSON.parse(
    readFileSync(join(DATA_DIR, "courses.json"), "utf-8")
);
const programs: Program[] = JSON.parse(
    readFileSync(join(DATA_DIR, "programs.json"), "utf-8")
);

function loadProfile(name: string): StudentProfile {
    return JSON.parse(
        readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8")
    );
}

function getProgram(id: string): Program {
    const p = programs.find((p) => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

function findRule(result: ReturnType<typeof degreeAudit>, ruleId: string) {
    const r = result.rules.find((r) => r.ruleId === ruleId);
    if (!r) throw new Error(`Rule ${ruleId} not found in audit result`);
    return r;
}

// ============================================================
// §1: CAS Core Audit — All 10 Core rules
// Source: CAS core rules.md
// ============================================================
describe("Core Complete — Full CAS Core Audit", () => {
    const student = loadProfile("core_complete");
    const casCore = getProgram("cas_core");
    const result = degreeAudit(student, casCore, courses);

    it("CC-09: Expository Writing satisfied", () => {
        const expos = findRule(result, "core_expos");
        expect(expos.status).toBe("satisfied");
        expect(expos.coursesSatisfying).toContain("EXPOS-UA 1");
    });

    it("CC-01: First-Year Seminar satisfied", () => {
        const fys = findRule(result, "core_fys");
        expect(fys.status).toBe("satisfied");
    });

    it("CC-03: Foreign Language satisfied (SPAN 1-4, last is Intermediate)", () => {
        const fl = findRule(result, "core_foreign_lang");
        expect(fl.status).toBe("satisfied");
        expect(fl.coursesSatisfying).toContain("SPAN-UA 4");
    });

    it("CC-11: Texts and Ideas satisfied (CORE-UA 501)", () => {
        const texts = findRule(result, "core_fcc_texts");
        expect(texts.status).toBe("satisfied");
        expect(texts.coursesSatisfying).toContain("CORE-UA 501");
    });

    it("CC-12: Cultures and Contexts satisfied (CORE-UA 601)", () => {
        const cultures = findRule(result, "core_fcc_cultures");
        expect(cultures.status).toBe("satisfied");
        expect(cultures.coursesSatisfying).toContain("CORE-UA 601");
    });

    it("CC-13: Societies satisfied (CORE-UA 701)", () => {
        const societies = findRule(result, "core_fcc_societies");
        expect(societies.status).toBe("satisfied");
        expect(societies.coursesSatisfying).toContain("CORE-UA 701");
    });

    it("CC-14: Expressive Culture satisfied (CORE-UA 801)", () => {
        const expressive = findRule(result, "core_fcc_expressive");
        expect(expressive.status).toBe("satisfied");
    });

    it("CC-15: QR satisfied (MATH-UA 121, double-count allowed)", () => {
        const qr = findRule(result, "core_fsi_quant");
        expect(qr.status).toBe("satisfied");
        expect(qr.coursesSatisfying).toContain("MATH-UA 121");
    });

    it("CC-16: Physical Science satisfied (PHYS-UA 11)", () => {
        const phys = findRule(result, "core_fsi_physical");
        expect(phys.status).toBe("satisfied");
        expect(phys.coursesSatisfying).toContain("PHYS-UA 11");
    });

    it("CC-17: Life Science satisfied (BIOL-UA 12)", () => {
        const life = findRule(result, "core_fsi_life");
        expect(life.status).toBe("satisfied");
        expect(life.coursesSatisfying).toContain("BIOL-UA 12");
    });

    it("overall CAS Core status is satisfied", () => {
        // All 10 rules should be satisfied
        expect(result.overallStatus).toBe("satisfied");
    });

    it("total credits = 60 (15 courses × 4)", () => {
        expect(result.totalCreditsCompleted).toBe(60);
    });
});

// ============================================================
// §2: Math Substitution Limit (MR-11)
// Source: Major rules line 54 "up to two of … MATH-UA 122, 140, 185"
// ============================================================
describe("Math Sub Overflow — Max 2 Math Substitutions (MR-11)", () => {
    const student = loadProfile("math_sub_overflow");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("MR-11: elective rule counts at most 2 math subs", () => {
        const electives = findRule(result, "cs_ba_electives");
        // 3 CS 400-level (467, 472, 474) + max 2 math subs = 5
        // Even though 3 math courses are from pool, only 2 count
        expect(electives.coursesSatisfying.length).toBe(5);
    });

    it("elective status = satisfied (3 CS + 2 math = 5 needed)", () => {
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.status).toBe("satisfied");
    });

    it("intro satisfied", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
    });

    it("core CS satisfied", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("satisfied");
    });

    it("total credits = 52 (13 courses × 4)", () => {
        expect(result.totalCreditsCompleted).toBe(52);
    });
});

// (Double-count tests removed — the source rule applies to double majors/major+minor
//  sharing, not within a single program. Out of scope for CS BA-only.)

// ============================================================
// §4: Transfer Credit Cap + Mixed AP/IB
// Source: GA lines 353 "max 32 advanced standing credits"
// ============================================================
describe("Transfer Heavy — AP/IB Mix + Credit Cap", () => {
    const student = loadProfile("transfer_heavy");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("EQ-01: AP CS A → CSCI-UA 101 satisfies intro", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
        expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
    });

    it("EQ-07: IB CS HL 6 → CSCI-UA 102 satisfies core", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.coursesSatisfying).toContain("CSCI-UA 102");
    });

    it("core CS all satisfied (AP 101, IB 102, NYU 201,310,202)", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("satisfied");
        expect(core.coursesSatisfying).toContain("CSCI-UA 201");
        expect(core.coursesSatisfying).toContain("CSCI-UA 310");
        expect(core.coursesSatisfying).toContain("CSCI-UA 202");
    });

    it("EQ-03: AP Calc BC 5 → MATH-UA 121 satisfies math calculus", () => {
        const calc = findRule(result, "cs_ba_math_calculus");
        expect(calc.status).toBe("satisfied");
    });

    it("transfer credits count in total", () => {
        // 5 NYU courses (20cr) + 6 mapped AP/IB (24cr) + 2 generic (8cr) = 52cr
        expect(result.totalCreditsCompleted).toBe(52);
    });

    it("CAP-09: advanced standing ≤ 32 — at 32cr exactly, no warning", () => {
        // Total AP/IB transfer: 6 mapped (24cr) + 2 generic (8cr) = 32cr exactly
        // Should be at exactly the cap, no warning
        const asWarning = result.warnings.find(
            (w) => w.toLowerCase().includes("advanced standing") || w.toLowerCase().includes("transfer credit")
        );
        expect(asWarning).toBeUndefined();
    });
});

// ============================================================
// §5: QR Double-Count (allow policy)
// MATH-UA 121 satisfies QR and CS math calculus simultaneously
// ============================================================
describe("Core Complete — QR Double-Count Allowed", () => {
    const student = loadProfile("core_complete");

    it("QR allows double-count: MATH-UA 121 can satisfy both QR and math req", () => {
        // Run Core audit — MATH-UA 121 satisfies QR
        const casCore = getProgram("cas_core");
        const coreResult = degreeAudit(student, casCore, courses);
        const qr = findRule(coreResult, "core_fsi_quant");
        expect(qr.coursesSatisfying).toContain("MATH-UA 121");

        // Run Major audit — MATH-UA 121 also satisfies cs_ba_math_calculus
        const csMajor = getProgram("cs_major_ba");
        const majorResult = degreeAudit(student, csMajor, courses);
        const calc = findRule(majorResult, "cs_ba_math_calculus");
        expect(calc.coursesSatisfying).toContain("MATH-UA 121");
    });

    it("QR has no double-count warnings", () => {
        const casCore = getProgram("cas_core");
        const coreResult = degreeAudit(student, casCore, courses);
        const qrWarnings = coreResult.warnings.filter(
            (w) => w.includes("MATH-UA 121") && (w.includes("double-count") || w.includes("already counted"))
        );
        expect(qrWarnings).toHaveLength(0);
    });
});
