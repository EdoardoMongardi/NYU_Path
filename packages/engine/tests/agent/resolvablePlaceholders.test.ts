// ============================================================
// K1 — resolvable placeholders for the sample DPR's two unmet leaves.
// ============================================================
// Plan 37 / Phase K / Issue C. The sample-DPR forward plan went
// "infeasible" because two unmet requirement leaves — Texts & Ideas
// (R1004/10, CORE-UA 400-499 pool) and Computer Science: Required
// Courses (R1142/20) — materialised as EMPTY `REQ-<rId>` placeholders
// instead of RESOLVABLE ones. The investigation found THREE root causes,
// all in the requirement→solver DERIVATION (the frozen solver / search /
// validator axes were NOT touched):
//
//   1. MAJOR-CREDIT FLOOR used the FULL `counter.required` of every major
//      units-leaf, even ALREADY-SATISFIED ones (the joint-major residency
//      "36 required, 56 used"). `checkMajorCreditFloor` (+ validator axis-4)
//      compare that floor against the FORWARD-planned major credits only, so
//      a fully-completed major demanded 36 forward credits that don't exist →
//      "Projected major credits 0 < 36" → no valid plan. FIX: the derived
//      floor is now the forward-REMAINING credits `max(0, required - used)`,
//      so a satisfied leaf contributes 0.
//
//   2. PAST/STALE IP rows (an IP term strictly before the wall-clock current
//      term) were placed in `coursesInProgress`; the solver maps an
//      out-of-window IP term to `currentTerm`, so a past SPRING-only IP landed
//      in a SUMMER current term and failed the forward offering check on that
//      FIXED placement, poisoning every search trial. FIX: a past/stale IP is
//      reconciled as TAKEN (no forward term, no offering check).
//
//   3. A CURRENT/FUTURE IP course pre-registered OUTSIDE its historical
//      offering season (MATH-UA 251: pre-registered Fall, historically
//      spring-only) failed the forward offering check on its FIXED placement,
//      again poisoning every trial. FIX: an in-progress course is an
//      established enrollment, so its forward offering entry is dropped (no
//      forward offering check on an IP placement — mirroring how
//      checkPrereqsSatisfied already exempts source:"ip").
//
// With all three derivation fixes the resolvable POOL placeholder + the bound
// CS course pass validator axes 1/2/4 → the plan is valid-with-trade-offs.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ToolSession } from "../../src/index.js";
import { loadCourses, loadPrereqs } from "../../src/dataLoader.js";
import {
    buildSolverInputWithRules,
    buildProgramRules,
} from "../../src/agent/forwardSchedule/buildSolverInput.js";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

const SAMPLE_TEXT = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function parsedSampleDpr(): DegreeProgressReport {
    const r = parseDpr(SAMPLE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r.report;
}

function sampleSession(dpr: DegreeProgressReport): ToolSession {
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
    };
}

// ---------------------------------------------------------------------------
// 1. Major-credit floor — DETERMINISTIC (no wall-clock dependence).
//    An already-satisfied major units-leaf (R1142/80: 36 required, 56 used)
//    must contribute 0 to the derived major-credit floor, so it does not
//    demand 36 forward credits the completed major has no room to supply.
// ---------------------------------------------------------------------------
describe("K1 — major-credit floor is forward-REMAINING, not full requirement", () => {
    it("an already-satisfied major units-leaf (required<=used) contributes 0 to majorCreditMinimum", () => {
        const dpr = parsedSampleDpr();
        const session = sampleSession(dpr);
        const { solverRules } = buildProgramRules(session, dpr, "2027-spring", 128);

        // The only units-counter major leaf in the sample DPR is R1142/80
        // (Computer Science/Math Joint Major: Residency — 36 required, 56 used,
        // status satisfied). It is already met by completed credits, so the
        // FORWARD-remaining major floor is 0 → null (no positive contribution).
        expect(solverRules.majorCreditMinimum).toBeNull();
    });

    it("an UNSATISFIED major units-leaf contributes only its forward shortfall (required - used)", () => {
        // Take the REAL sample DPR (so the joint-major group/leaf classification
        // is faithful) and make its single major units-leaf R1142/80 UNSATISFIED
        // with a 16-credit shortfall (36 required, 20 used). The forward major
        // floor must then be exactly 16 — the remaining credits, NOT the full 36.
        const baseDpr = parsedSampleDpr();
        const mutate = (node: DegreeProgressReport["requirementGroups"][number]): typeof node => ({
            ...node,
            children: node.children.map(child => {
                if ("children" in child) return mutate(child);
                if (child.rId === "R1142/80") {
                    return {
                        ...child,
                        status: "not_satisfied" as const,
                        counter: { kind: "units" as const, required: 36, used: 20, needed: 16 },
                    };
                }
                return child;
            }),
        });
        const dpr: DegreeProgressReport = {
            ...baseDpr,
            requirementGroups: baseDpr.requirementGroups.map(mutate),
        };
        const session = sampleSession(dpr);
        const { solverRules } = buildProgramRules(session, dpr, "2027-spring", 128);
        // 36 required - 20 used = 16 forward-remaining.
        expect(solverRules.majorCreditMinimum).toBe(16);
    });
});

// ---------------------------------------------------------------------------
// 2. IP reconciliation — DETERMINISTIC, via an explicit graduationTermOverride
//    that fixes the horizon (so the auto-extend window is irrelevant) and a
//    synthetic DPR whose IP rows are all CURRENT/FUTURE (so the result does
//    not depend on the run date).
//
//    A future-term IP course (FALL) that is historically SPRING-only must NOT
//    poison the search: its forward offering entry is dropped, so the FIXED IP
//    placement faces no offering check and the unmet leaf still resolves.
// ---------------------------------------------------------------------------
describe("K1 — an IP course pre-registered outside its offering season does not poison the plan", () => {
    it("the solver input drops the forward offering entry for an in-progress course", () => {
        const dpr = parsedSampleDpr();
        const session = sampleSession(dpr);
        const { solverInput } = buildSolverInputWithRules(session, dpr, {
            graduationTermOverride: "2028-spring",
        });

        // Every course the builder put in coursesInProgress must have NO forward
        // offering entry (an established enrollment faces no forward offering check).
        for (const ipId of solverInput.coursesInProgress.keys()) {
            expect(solverInput.offerings.has(ipId)).toBe(false);
        }
        // MATH-UA 251 (sample Fall-2026 IP, historically spring-only) is the
        // concrete instance — it must be among the in-progress ids and absent
        // from offerings.
        expect(solverInput.coursesInProgress.has("MATH-UA 251")).toBe(true);
        expect(solverInput.offerings.has("MATH-UA 251")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. End-to-end — the sample DPR yields a VALID plan whose two formerly-empty
//    leaves are now RESOLVABLE (not empty REQ-<rId> placeholders).
//
//    Robust to the run date: we pin a generous graduation horizon
//    (graduationTermOverride) so a spring term always exists for the spring-only
//    CS course, and assert the two leaves resolve regardless of which future
//    term they land in.
// ---------------------------------------------------------------------------
describe("K1 — sample DPR: both unmet leaves materialise as RESOLVABLE placeholders", () => {
    it("R1004/10 (Texts & Ideas) is a non-empty POOL placeholder and R1142/20 (CS-Required) is bound/non-empty → valid plan", () => {
        const dpr = parsedSampleDpr();
        const session = sampleSession(dpr);
        // A generous fixed horizon guarantees at least one spring term for the
        // spring-only CS course, independent of today's date.
        const schedule = buildForwardSchedule({ session, dpr, graduationTermOverride: "2028-spring" });

        const slots = schedule.semesters.flatMap(s => s.slots);
        const slotsFor = (rId: string) =>
            slots.filter(s => (s.satisfiesRules ?? []).includes(rId));

        // ---- R1004/10 (Texts & Ideas, CORE-UA 400-499 pool) ----
        const texts = slotsFor("R1004/10");
        expect(texts.length).toBeGreaterThan(0);
        const textsSlot = texts[0]!;
        // It is NOT an empty REQ-<rId> placeholder: it carries a resolvable
        // poolBinding with the real CORE-UA 400-499 catalog members.
        expect(textsSlot.kind).toBe("placeholder");
        if (textsSlot.kind === "placeholder") {
            expect(textsSlot.placeholderId).toBe("POOL-R1004/10");
            expect(textsSlot.poolBinding).toBeDefined();
            expect(textsSlot.poolBinding!.candidates.length).toBeGreaterThan(0);
            // CORE-UA 402 is a real catalog member of the 400-499 range.
            expect(textsSlot.poolBinding!.candidates).toContain("CORE-UA 402");
        }
        // Explicitly NOT the empty-placeholder form.
        expect(textsSlot.kind === "placeholder" && textsSlot.placeholderId === "REQ-R1004/10").toBe(false);

        // ---- R1142/20 (Computer Science: Required Courses) ----
        const cs = slotsFor("R1142/20");
        expect(cs.length).toBeGreaterThan(0);
        const csSlot = cs[0]!;
        // It resolves to a CONCRETE course (specific_planned) OR a resolvable
        // pool placeholder — in either case NOT an empty REQ-<rId> placeholder.
        const csIsEmptyPlaceholder =
            csSlot.kind === "placeholder" &&
            csSlot.placeholderId === "REQ-R1142/20" &&
            csSlot.poolBinding === undefined;
        expect(csIsEmptyPlaceholder).toBe(false);

        // ---- The plan as a whole is VALID (not infeasible-draft) ----
        expect(schedule.state).toMatch(/^valid/);
        expect(schedule.feasibility.feasible).toBe(true);
    });
});
