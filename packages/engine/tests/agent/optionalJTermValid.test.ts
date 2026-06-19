// ============================================================
// L1 — an additive, optional J-term of free electives is VALID.
// ============================================================
// Plan 37 / Phase L / Issue D. A prior test reported "infeasible" when a
// student opened a January (J-term) — but that was a SOLVER ARTIFACT, NOT
// a real NYU-rule violation:
//
//   - A J-term is OPTIONAL: it is not needed to graduate, the F-1 full-time
//     floor applies per fall/spring semester (a winter/J-term does not carry
//     the 12-credit floor), and the per-semester credit ceiling is a
//     fall/spring ceiling. So a January of nothing-but-free-electives — or
//     even an EMPTY January — is technically valid; it simply isn't needed.
//
//   - The artifact: opening January (`includeJTerm`) gave the solver the
//     freedom to relocate a MOVABLE / not-yet-bound requirement placeholder
//     (the Texts & Ideas CORE-UA pool) into January, where CORE-UA courses
//     are NOT offered (`course.termsOffered` excludes january). The OFFERING
//     constraint is real + correct; the artifact was the solver's freedom to
//     drop an unbound placeholder into a non-offering term.
//
// K1 (Phase K) bound each unmet requirement leaf to specific not-yet-taken
// courses WITH real offering data:
//   - R1142/20 "CS-Required"  → CSCI-UA 421 (spring-only)
//   - R1004/10 "Texts & Ideas" → a CORE-UA 400-499 POOL whose members are all
//     fall/spring-only (no CORE-UA course is offered in January).
//
// So the offering constraint now KEEPS both requirement courses out of January
// on its own. This test LOCKS THAT IN: opening a J-term of free electives on
// the sample DPR yields a VALID plan AND neither requirement course is
// relocated into January — it is a REGRESSION test (the artifact is already
// dissolved; no fix was needed). The frozen solver / search / validator and
// the preferences/mutation plumbing are untouched by L1.
//
// Date-robust: a fixed graduationTermOverride ("2028-spring") pins a generous
// horizon (a spring term always exists for the spring-only CS course), so the
// result does not depend on the run date — exactly as the K1 integration test.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ToolSession } from "../../src/index.js";
import { loadCourses, loadPrereqs } from "../../src/dataLoader.js";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { applyMutationsToPreferences } from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { SchedulePreferences } from "@nyupath/shared";

const SAMPLE_TEXT = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function parsedSampleDpr(): DegreeProgressReport {
    const r = parseDpr(SAMPLE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r.report;
}

function sampleSession(
    dpr: DegreeProgressReport,
    schedulePreferences?: SchedulePreferences,
): ToolSession {
    return {
        student: {
            id: "sample_student",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science_math", programType: "major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        degreeProgressReport: dpr,
        courses: loadCourses(),
        prereqs: loadPrereqs(),
        ...(schedulePreferences ? { schedulePreferences } : {}),
    };
}

const GRAD_OVERRIDE = "2028-spring";

/** Find the (term, slot) where a requirement leaf `rId` is satisfied, or null. */
function findReqTerm(
    schedule: ReturnType<typeof buildForwardSchedule>,
    rId: string,
): string | null {
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            if ((slot.satisfiesRules ?? []).includes(rId)) return sem.term;
        }
    }
    return null;
}

/** Every (term, slot) placed into a January term. */
function januarySlots(schedule: ReturnType<typeof buildForwardSchedule>) {
    return schedule.semesters
        .filter(sem => sem.term.endsWith("-january"))
        .flatMap(sem => sem.slots.map(slot => ({ term: sem.term, slot })));
}

// ---------------------------------------------------------------------------
// 0. The addTerm("january") mutation flips includeJTerm — the canonical path
//    that the "add a J-term" affordance / agent mutation produces. We pin it
//    so the rest of the suite's `includeJTerm:true` faithfully mirrors what a
//    real addTerm mutation yields.
// ---------------------------------------------------------------------------
describe("L1 — addTerm('january') flips includeJTerm", () => {
    it("a {kind:'addTerm', term:'2027-january'} mutation sets includeJTerm:true", () => {
        const { prefs } = applyMutationsToPreferences(
            {},
            [{ kind: "addTerm", term: "2027-january" }],
        );
        expect(prefs.includeJTerm).toBe(true);
        // and does NOT spuriously open summer
        expect(prefs.includeSummer).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 1. The core L1 finding — opening a J-term of free electives keeps the plan
//    VALID and does NOT relocate a requirement into a non-offering January.
// ---------------------------------------------------------------------------
describe("L1 — an additive optional J-term of free electives is valid (no requirement relocated)", () => {
    it("baseline (no J-term): sample DPR is valid and the requirement courses sit in fall/spring", () => {
        const dpr = parsedSampleDpr();
        const base = buildForwardSchedule({
            session: sampleSession(dpr),
            dpr,
            graduationTermOverride: GRAD_OVERRIDE,
        });

        expect(base.state).toMatch(/^valid/);
        expect(base.feasibility.feasible).toBe(true);

        // The two formerly-empty leaves resolve into fall/spring terms (NOT january).
        const cs = findReqTerm(base, "R1142/20"); // CSCI-UA 421 (spring-only)
        const texts = findReqTerm(base, "R1004/10"); // CORE-UA 400-499 pool
        expect(cs).not.toBeNull();
        expect(texts).not.toBeNull();
        expect(cs!.endsWith("-january")).toBe(false);
        expect(texts!.endsWith("-january")).toBe(false);
    });

    it("with includeJTerm: the plan stays VALID and NO requirement is relocated into January", () => {
        const baseDpr = parsedSampleDpr();
        const base = buildForwardSchedule({
            session: sampleSession(baseDpr),
            dpr: baseDpr,
            graduationTermOverride: GRAD_OVERRIDE,
        });

        const jDpr = parsedSampleDpr();
        const withJ = buildForwardSchedule({
            session: sampleSession(jDpr, { includeJTerm: true }),
            dpr: jDpr,
            graduationTermOverride: GRAD_OVERRIDE,
        });

        // (a) Adding the optional J-term does NOT make the plan infeasible —
        //     it stays valid (the artifact is dissolved).
        expect(withJ.state).toMatch(/^valid/);
        expect(withJ.feasibility.feasible).toBe(true);

        // (b) The requirement courses stay in their ORIGINAL (non-January) terms —
        //     opening the J-term did NOT relocate either one.
        const csBase = findReqTerm(base, "R1142/20");
        const csWithJ = findReqTerm(withJ, "R1142/20");
        const textsBase = findReqTerm(base, "R1004/10");
        const textsWithJ = findReqTerm(withJ, "R1004/10");

        expect(csWithJ).toBe(csBase); // CSCI-UA 421 unchanged
        expect(textsWithJ).toBe(textsBase); // Texts & Ideas pool unchanged
        expect(csWithJ!.endsWith("-january")).toBe(false);
        expect(textsWithJ!.endsWith("-january")).toBe(false);

        // (c) NO January term holds a requirement-satisfying slot. (The solver
        //     places only free-elective / empty terms into January — never a
        //     requirement, because the offering constraint forbids CORE-UA /
        //     CSCI-UA there.) A January slot, if any, must satisfy NO rule.
        for (const { slot } of januarySlots(withJ)) {
            expect(slot.satisfiesRules ?? []).toHaveLength(0);
        }
    });

    it("no CORE-UA / CSCI-UA requirement course is offering-legal in January (the constraint that dissolves the artifact)", () => {
        // A direct, data-grounded guard: every slot that satisfies a requirement
        // leaf in the with-J plan lives in a fall/spring term, never January.
        const jDpr = parsedSampleDpr();
        const withJ = buildForwardSchedule({
            session: sampleSession(jDpr, { includeJTerm: true }),
            dpr: jDpr,
            graduationTermOverride: GRAD_OVERRIDE,
        });
        for (const sem of withJ.semesters) {
            if (!sem.term.endsWith("-january")) continue;
            for (const slot of sem.slots) {
                // No requirement satisfier may land in January.
                expect(slot.satisfiesRules ?? []).toHaveLength(0);
            }
        }
    });
});
