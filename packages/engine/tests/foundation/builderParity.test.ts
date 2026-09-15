/**
 * Task 1.10 — RC-4/PLAN-2: builder parity tests.
 *
 * Proves the unified buildSolverInput produces the same critical fields
 * whether called from the initial-plan path (buildForwardSchedule) or
 * the edit path (buildSolverInputFromSession, which is now a thin wrapper).
 *
 * Three assertions prove the three divergences are eliminated:
 *  1. graduationTerm — both paths honor session.graduationTarget (NOT credits-only)
 *  2. currentTerm — both paths use wall-clock (deriveTemporalContext), not last-IP
 *  3. coreqs — both paths build the coreq map (non-zero when session.prereqs has coreqs)
 *
 * Additional parity checks: offerings non-empty, programRules equal.
 *
 * ⚑ FROZEN CLOCK. currentTerm is derived from the WALL CLOCK
 * (deriveTemporalContext via `new Date()`), so this suite pins the clock to
 * 2026-06-05 — the date it was authored against. Without the pin the
 * currentTerm assertion below drifts with real time and, once real time
 * reached Fall 2026, its "not the stale fallback" sentinel silently collided
 * with the correct wall-clock answer ("2026-fall") and the suite began
 * failing for calendar reasons rather than code reasons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildSolverInput } from "../../src/agent/forwardSchedule/buildSolverInput.js";
import { buildSolverInputFromSession } from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

/**
 * Minimal DPR with:
 * - 96 credits used (32 remaining to 128 minimum)
 * - No IP rows (so inferring from last-IP would fall back to default "2026-fall",
 *   while wall-clock from the frozen test date of 2026-06-05 yields "2026-summer")
 * - residencyRequired = 64 (so residencyMinCredits is non-null in both paths)
 * - One requirement group with a major-required leaf (so majorCreditMinimum > 0)
 */
function makeFixtureDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Parity Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 48,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [
            {
                // Group — uses rgId (not rId) so walkRequirements treats it as a group
                rgId: "RG9999",
                title: "Computer Science",
                status: "not_satisfied",
                statusText: "0 of 1 required",
                children: [
                    {
                        // Inner group — also uses rgId
                        rgId: "RG9999-1",
                        title: "CS Major Core",
                        status: "not_satisfied",
                        statusText: "0 of 1 required",
                        children: [
                            {
                                // Leaf — uses rId so walkRequirements picks it up
                                rId: "r1",
                                title: "CSCI-UA 102",
                                status: "not_satisfied",
                                statusText: "needs CSCI-UA 102",
                                counter: { kind: "units", required: 4, used: 0, needed: 4 },
                                coursesUsed: [],
                            },
                        ],
                    },
                ],
            },
        ],
        courseHistory: [],
    };
}

/**
 * Session with:
 * - graduationTarget = "Spring 2027" (display form) → should map to "2027-spring"
 * - prereqs includes a course with coreqs so coreqs map is non-empty
 * - courses catalog has entries so courseCatalog is non-empty
 */
function makeFixtureSession(): ToolSession {
    return {
        student: {
            id: "parity-test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [
                { programId: "computer_science", programType: "major" },
            ],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: {
            schoolId: "cas",
            name: "College of Arts and Science",
            degreeType: "BA",
            courseSuffix: ["-UA"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: { minCredits: 64, note: null },
            creditTargetPerSemester: 16,
            domesticPartTimeFloor: 8,
        },
        graduationTarget: "Spring 2027",
        courses: [
            { id: "CSCI-UA 102", title: "Data Structures", credits: 4 },
            { id: "CSCI-UA 201", title: "Computer Systems Organization", credits: 4 },
        ],
        prereqs: [
            {
                course: "CSCI-UA 201",
                prereqGroups: [
                    {
                        kind: "AND",
                        requirements: [
                            { kind: "course", courseId: "CSCI-UA 102", minGrade: "C" },
                        ],
                    },
                ],
                coreqs: ["MATH-UA 120"],
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RC-4/PLAN-2 — unified buildSolverInput parity", () => {
    const dpr = makeFixtureDpr();
    const session = makeFixtureSession();

    // Pin the wall clock to the date this suite was authored against, so
    // currentTerm derivation is deterministic forever. `toFake: ["Date"]`
    // fakes ONLY the clock — setTimeout/setInterval keep real behavior, so a
    // future async addition to the builder cannot hang on a frozen timer.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-06-05T00:00:00Z"));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("buildSolverInput is importable", () => {
        expect(typeof buildSolverInput).toBe("function");
    });

    it("buildSolverInput and buildSolverInputFromSession produce equal graduationTerm", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        expect(direct.graduationTerm).toBe(fromSession.graduationTerm);
    });

    it("PLAN-2 fix: both paths honor session.graduationTarget = 'Spring 2027' → '2027-spring'", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        // Both must honor the stated graduation goal, NOT derive from credits
        expect(direct.graduationTerm).toBe("2027-spring");
        expect(fromSession.graduationTerm).toBe("2027-spring");
    });

    it("both paths use wall-clock currentTerm (not last-IP row)", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        // Both must agree (unified builder used for both).
        expect(direct.currentTerm).toBe(fromSession.currentTerm);

        // With the clock frozen to 2026-06-05, wall-clock resolves to
        // "2026-summer" (termInSession: June → Summer). Assert that
        // POSITIVELY — it pins the derived value instead of merely excluding
        // one, so a future drift in the season boundaries fails loudly here.
        expect(fromSession.currentTerm).toBe("2026-summer");

        // "2026-fall" is the value BOTH stale paths produce: the old edit-path
        // last-IP fallback (this fixture deliberately has no IP rows) AND
        // inferCurrentTerm's own defensive fallback in buildSolverInput.ts.
        // Excluding it proves the wall-clock path actually ran.
        // ⚑ This sentinel only discriminates while the clock is frozen off
        // Fall — it is exactly the assertion that broke when real time reached
        // Fall 2026 and "2026-fall" became the CORRECT answer. Keep the pin.
        expect(fromSession.currentTerm).not.toBe("2026-fall");
    });

    it("both paths build a coreq map (non-empty when prereqs has coreqs)", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        // Both must have coreqs (previously the edit path built NO coreq map)
        expect(direct.coreqs).toBeDefined();
        expect(fromSession.coreqs).toBeDefined();
        expect(direct.coreqs!.size).toBeGreaterThan(0);
        expect(fromSession.coreqs!.size).toBeGreaterThan(0);
        // Coreq maps must agree
        expect(direct.coreqs!.size).toBe(fromSession.coreqs!.size);
        expect(direct.coreqs!.get("CSCI-UA 201")).toEqual(fromSession.coreqs!.get("CSCI-UA 201"));
    });

    it("both paths produce non-empty offerings map", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        // Previously the edit path always returned empty offerings maps
        expect(fromSession.offerings.size).toBeGreaterThan(0);
        expect(direct.offerings.size).toBeGreaterThan(0);
        expect(direct.offerings.size).toBe(fromSession.offerings.size);
    });

    it("both paths produce equal programRules.majorCreditMinimum", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        expect(direct.programRules.majorCreditMinimum).toBe(fromSession.programRules.majorCreditMinimum);
        // Must be non-null (the fixture has a major-required leaf with 4 credits)
        expect(direct.programRules.majorCreditMinimum).not.toBeNull();
    });

    it("both paths produce equal programRules.residencyMinCredits", () => {
        const direct = buildSolverInput(session, dpr, {});
        const fromSession = buildSolverInputFromSession(session, dpr);

        expect(direct.programRules.residencyMinCredits).toBe(fromSession.programRules.residencyMinCredits);
        // DPR has residencyRequired = 64
        expect(fromSession.programRules.residencyMinCredits).toBe(64);
    });

    it("graduationTermOverride takes precedence over session.graduationTarget", () => {
        const override = buildSolverInput(session, dpr, { graduationTermOverride: "2028-fall" });
        expect(override.graduationTerm).toBe("2028-fall");
    });

    it("preferences from session.schedulePreferences flow through buildSolverInputFromSession", () => {
        const sessionWithPrefs: ToolSession = {
            ...session,
            schedulePreferences: {
                loadStyle: "frontload",
                pins: [{ courseId: "CSCI-UA 102", term: "2026-fall" }],
            },
        };
        const fromSession = buildSolverInputFromSession(sessionWithPrefs, dpr);
        expect(fromSession.preferences?.loadStyle).toBe("frontload");
        expect(fromSession.preferences?.pins).toHaveLength(1);
    });
});
