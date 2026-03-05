// ============================================================
// Week 1 — Deterministic Degree Audit Tests
// Rule-sourced scenarios from validation_spec.md §3
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

// Load shared data
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
// Baseline: Empty student
// Validates: All rules not_started, 0 credits
// ============================================================
describe("Empty Student — Baseline", () => {
    const student = loadProfile("empty");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("overall status is not_started", () => {
        expect(result.overallStatus).toBe("not_started");
    });

    it("all rules are not_started", () => {
        for (const rule of result.rules) {
            expect(rule.status).toBe("not_started");
        }
    });

    it("total credits completed = 0", () => {
        expect(result.totalCreditsCompleted).toBe(0);
    });
});

// ============================================================
// MR-07: Intro CS partial completion
// Source: Major rules line 21
// ============================================================
describe("Freshman Clean — Intro CS (MR-07)", () => {
    const student = loadProfile("freshman_clean");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("overall status is in_progress", () => {
        expect(result.overallStatus).toBe("in_progress");
    });

    it("intro CS is satisfied (101 taken — choose_1 from [101, 110])", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
        expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
    });

    it("core CS is in_progress (102 taken, still need 201, 202, 310)", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("in_progress");
        expect(core.coursesSatisfying).toContain("CSCI-UA 102");
    });

    it("electives are not_started (no 400-level courses)", () => {
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.status).toBe("not_started");
    });

    it("total credits = 32 (8 courses × 4)", () => {
        expect(result.totalCreditsCompleted).toBe(32);
    });
});

// ============================================================
// Grade-Aware Filtering (GF-01 through GF-06)
// Source: MR line 7 (major=C), GA line 38 (Core=D)
// ============================================================
describe("Sophomore Mixed Grades — Grade Filtering", () => {
    const student = loadProfile("sophomore_mixed_grades");

    describe("CS Major Audit (requires C or better)", () => {
        const csMajor = getProgram("cs_major_ba");
        const result = degreeAudit(student, csMajor, courses);

        it("MR-04: C in CSCI-UA 201 DOES satisfy major", () => {
            const core = findRule(result, "cs_ba_core");
            expect(core.coursesSatisfying).toContain("CSCI-UA 201");
        });

        it("GF-01: C- in CSCI-UA 202 does NOT satisfy major core", () => {
            const core = findRule(result, "cs_ba_core");
            // CSCI-UA 202 got C- → below C → doesn't count for major
            expect(core.coursesSatisfying).not.toContain("CSCI-UA 202");
        });

        it("GF-03: C- earns graduation credits", () => {
            // All 14 courses have passing grades (C- through A), all earn graduation credits
            // C- in 202 earns credits toward 128 total even though it doesn't count for major
            expect(result.totalCreditsCompleted).toBe(56);
        });

        it("MR-04: C in CSCI-UA 101 DOES satisfy major intro (minimum passing)", () => {
            const intro = findRule(result, "cs_ba_intro");
            // C is the minimum grade that satisfies CS major requirements
            expect(intro.status).toBe("satisfied");
            expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
        });

        it("core CS in_progress: 102(B) + 201(C) + 310(B) pass, 202(C-) fails", () => {
            const core = findRule(result, "cs_ba_core");
            expect(core.status).toBe("in_progress");
            expect(core.coursesSatisfying).toContain("CSCI-UA 102");
            expect(core.coursesSatisfying).toContain("CSCI-UA 201");
            expect(core.coursesSatisfying).toContain("CSCI-UA 310");
            expect(core.coursesSatisfying).not.toContain("CSCI-UA 202");
        });
    });

    describe("CAS Core Audit (requires D or better)", () => {
        const casCore = getProgram("cas_core");
        const result = degreeAudit(student, casCore, courses);

        it("CC-21: D in CORE-UA 501 DOES satisfy Core (Texts & Ideas)", () => {
            const textsIdeas = findRule(result, "core_fcc_texts");
            expect(textsIdeas.status).toBe("satisfied");
            expect(textsIdeas.coursesSatisfying).toContain("CORE-UA 501");
        });

        it("GF-02: C- in CORE-UA 701 DOES satisfy Core (Societies)", () => {
            const societies = findRule(result, "core_fcc_societies");
            expect(societies.status).toBe("satisfied");
            expect(societies.coursesSatisfying).toContain("CORE-UA 701");
        });

        it("CC-09: B in EXPOS-UA 1 satisfies Expository Writing", () => {
            const expos = findRule(result, "core_expos");
            expect(expos.status).toBe("satisfied");
        });

        it("CC-03: FL satisfied (SPAN-UA 1 through 4 completed)", () => {
            const fl = findRule(result, "core_foreign_lang");
            expect(fl.status).toBe("satisfied");
        });
    });
});

// ============================================================
// Transfer Credit / AP Equivalencies (EQ-01, EQ-03, EQ-05)
// Source: TC lines 163, 157, 173
// ============================================================
describe("Freshman AP — Transfer Credits", () => {
    const student = loadProfile("freshman_ap");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("EQ-01: AP CS A → CSCI-UA 101 satisfies intro", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
    });

    it("intro is satisfied (AP CS A → 101)", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
        // intro is choose_1 from [101, 110]; 102 is in cs_ba_core
    });

    it("core CS in_progress (NYU 102 taken, still need 201, 202, 310)", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("in_progress");
        expect(core.coursesSatisfying).toContain("CSCI-UA 102");
    });

    it("transfer credits contribute to total", () => {
        // 5 NYU courses (4cr each) = 20 + 4 mapped transfers (4cr each) = 16 + 1 generic (4cr) = 4
        // AP Calc BC score 5 = 8cr split into MATH-UA 121 (4cr) + MATH-UA 122 (4cr)
        // Total = 20 + 16 + 4 = 40
        expect(result.totalCreditsCompleted).toBe(40);
    });
});

// ============================================================
// MR-09, MR-10: Elective minLevel = 400
// Source: Major rules line 54 ("CSCI-UA.04xx")
// ============================================================
describe("Senior Almost Done — Elective Level Check (MR-09, MR-10)", () => {
    const student = loadProfile("senior_almost_done");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("MR-10: 5+ electives at 400-level → electives satisfied", () => {
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.status).toBe("satisfied");
        // CSCI-UA 467, 472, 474, 480, 473, 478 are all 400-level
        expect(electives.coursesSatisfying.length).toBeGreaterThanOrEqual(5);
    });

    it("MR-08: all 5 core CS courses satisfied", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("satisfied");
        expect(core.coursesSatisfying).toContain("CSCI-UA 201");
        expect(core.coursesSatisfying).toContain("CSCI-UA 202");
        expect(core.coursesSatisfying).toContain("CSCI-UA 310");
    });

    it("MR-07: intro satisfied", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
    });
});

// ============================================================
// CC-04: FL Exemption via nonEnglishSecondary flag
// Source: CAS core rules line 66
// ============================================================
describe("FL Exempt Student — Flag Exemption (CC-04)", () => {
    const student = loadProfile("fl_exempt");
    const casCore = getProgram("cas_core");
    const result = degreeAudit(student, casCore, courses);

    it("CC-04: FL requirement is exempt", () => {
        const fl = findRule(result, "core_foreign_lang");
        expect(fl.status).toBe("satisfied");
        expect(fl.exemptReason).toBeDefined();
    });
});

// ============================================================
// Credit Cap Validation (CAP-01, CAP-03, CAP-04, CAP-08)
// Source: GA lines 196, 188, 220, 353
// ============================================================
describe("Credit Cap Stress — Cap Violations", () => {
    const student = loadProfile("credit_cap_stress");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("CAP-01: UA credits 50 < 64 → residency warning", () => {
        const hasResidencyWarning = result.warnings.some(
            (w) => w.toLowerCase().includes("ua") || w.toLowerCase().includes("residency")
        );
        expect(hasResidencyWarning).toBe(true);
    });

    it("CAP-03: non-CAS NYU 20 > 16 → over-limit warning", () => {
        const hasNonCASWarning = result.warnings.some(
            (w) => w.toLowerCase().includes("non-cas") || w.toLowerCase().includes("other division")
        );
        expect(hasNonCASWarning).toBe(true);
    });

    it("CAP-04: online credits 28 > 24 → over-limit warning", () => {
        const hasOnlineWarning = result.warnings.some(
            (w) => w.toLowerCase().includes("online")
        );
        expect(hasOnlineWarning).toBe(true);
    });

    it("CAP-08: P/F credits 36 > 32 → career limit warning", () => {
        const hasPFWarning = result.warnings.some(
            (w) => w.toLowerCase().includes("pass/fail") || w.toLowerCase().includes("p/f")
        );
        expect(hasPFWarning).toBe(true);
    });

    it("at least 4 credit cap warnings total", () => {
        // Should trigger: residency, non-CAS, online, P/F
        expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    });
});
