/**
 * P2.10 — Phase-1 follow-ups fold-in.
 *
 * Covers three of the four follow-ups (the fourth, (c) course-count major
 * floors, is a documented deferral with no runtime behavior to assert):
 *
 *  (a) solver warnings channel — when the DPR omits the degree credit minimum
 *      the builder pushes an assumed-128 advisory onto SolverInput.warnings,
 *      and that advisory rides through SolverOutput.warnings → ForwardSchedule.warnings.
 *      Present `creditsRequired` ⇒ no such warning.
 *
 *  (b) one buildProgramRules call per path — buildSolverInputWithRules returns
 *      `validatorRules` equal to a direct buildProgramRules(...).validatorRules,
 *      and buildForwardSchedule still produces a schedule.
 *
 *  (d) preferencesOverride — buildSolverInput(session, dpr, { preferencesOverride })
 *      uses the override WITHOUT mutating session.schedulePreferences, and
 *      buildSolverInputFromSession(session, dpr, P) no longer mutates the session.
 */

import { describe, it, expect } from "vitest";
import {
    buildSolverInput,
    buildSolverInputWithRules,
    buildProgramRules,
} from "../../src/agent/forwardSchedule/buildSolverInput.js";
import {
    buildSolverInputFromSession,
    buildSolverInputWithRulesFromSession,
} from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { SchedulePreferences } from "@nyupath/shared";

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
 * Minimal DPR with creditsRequired present (128). Used as the baseline; the
 * (a) tests clone it and delete creditsRequired to exercise the assumed-128 path.
 */
function makeFixtureDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "P2.10 Test Student", preparedDate: "01/01/2026" },
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
                rgId: "RG9999",
                title: "Computer Science",
                status: "not_satisfied",
                statusText: "0 of 1 required",
                children: [
                    {
                        rgId: "RG9999-1",
                        title: "CS Major Core",
                        status: "not_satisfied",
                        statusText: "0 of 1 required",
                        children: [
                            {
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

function makeFixtureSession(): ToolSession {
    return {
        student: {
            id: "p2-10-test-student",
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

const ASSUMED_128_FRAGMENT = "Degree credit minimum not found in the DPR";

// ===========================================================================
// (a) — warnings channel
// ===========================================================================

describe("P2.10 (a) — solver warnings channel", () => {
    it("buildSolverInput pushes the assumed-128 warning when creditsRequired is absent", () => {
        const dpr = makeFixtureDpr();
        delete (dpr.cumulative as { creditsRequired?: number }).creditsRequired;
        const input = buildSolverInput(makeFixtureSession(), dpr, {});

        expect(input.warnings).toBeDefined();
        expect(input.warnings.some(w => w.includes(ASSUMED_128_FRAGMENT))).toBe(true);
        // The assumed minimum (128) and the verify-with-school nudge are both present.
        const warning = input.warnings.find(w => w.includes(ASSUMED_128_FRAGMENT))!;
        expect(warning).toContain("128");
        expect(warning).toContain("Verify the requirement with your school");
        // And the default was actually applied.
        expect(input.graduationCreditMinimum).toBe(128);
    });

    it("buildSolverInput emits NO assumed-128 warning when creditsRequired is present", () => {
        const dpr = makeFixtureDpr(); // creditsRequired: 128 present
        const input = buildSolverInput(makeFixtureSession(), dpr, {});

        expect(input.warnings).toEqual([]);
        expect(input.warnings.some(w => w.includes(ASSUMED_128_FRAGMENT))).toBe(false);
    });

    it("the warning rides through SolverOutput.warnings", () => {
        const dpr = makeFixtureDpr();
        delete (dpr.cumulative as { creditsRequired?: number }).creditsRequired;
        const input = buildSolverInput(makeFixtureSession(), dpr, {});
        const output = solveForwardSchedule(input);

        expect(output.warnings).toBeDefined();
        expect(output.warnings!.some(w => w.includes(ASSUMED_128_FRAGMENT))).toBe(true);
    });

    it("SolverOutput.warnings is undefined (omitted) when there are no warnings", () => {
        const dpr = makeFixtureDpr();
        const input = buildSolverInput(makeFixtureSession(), dpr, {});
        const output = solveForwardSchedule(input);

        expect(output.warnings).toBeUndefined();
    });

    it("the warning reaches ForwardSchedule.warnings (end-to-end via buildForwardSchedule)", () => {
        const dpr = makeFixtureDpr();
        delete (dpr.cumulative as { creditsRequired?: number }).creditsRequired;
        const schedule = buildForwardSchedule({ session: makeFixtureSession(), dpr });

        expect(schedule.warnings).toBeDefined();
        expect(schedule.warnings!.some(w => w.includes(ASSUMED_128_FRAGMENT))).toBe(true);
    });

    it("ForwardSchedule.warnings is omitted when the DPR carries creditsRequired", () => {
        const schedule = buildForwardSchedule({ session: makeFixtureSession(), dpr: makeFixtureDpr() });
        expect(schedule.warnings).toBeUndefined();
    });
});

// ===========================================================================
// (b) — one buildProgramRules call per path
// ===========================================================================

describe("P2.10 (b) — single buildProgramRules per path", () => {
    it("buildSolverInputWithRules.validatorRules equals a direct buildProgramRules(...).validatorRules", () => {
        const dpr = makeFixtureDpr();
        const session = makeFixtureSession();

        const bundle = buildSolverInputWithRules(session, dpr, {});
        const direct = buildProgramRules(
            session,
            dpr,
            bundle.solverInput.graduationTerm,
            bundle.solverInput.graduationCreditMinimum,
        );

        expect(bundle.validatorRules).toEqual(direct.validatorRules);
        // And the bundle's solverRules match what landed on the SolverInput.
        expect(bundle.solverRules).toBe(bundle.solverInput.programRules);
    });

    it("buildSolverInputWithRulesFromSession returns validatorRules consistent with the solverInput", () => {
        const dpr = makeFixtureDpr();
        const session = makeFixtureSession();

        const bundle = buildSolverInputWithRulesFromSession(session, dpr);
        const direct = buildProgramRules(
            session,
            dpr,
            bundle.solverInput.graduationTerm,
            bundle.solverInput.graduationCreditMinimum,
        );

        expect(bundle.validatorRules).toEqual(direct.validatorRules);
    });

    it("buildForwardSchedule still produces a coherent schedule (smoke)", () => {
        const schedule = buildForwardSchedule({ session: makeFixtureSession(), dpr: makeFixtureDpr() });
        expect(schedule.graduationTerm).toBe("2027-spring");
        expect(schedule.semesters.length).toBeGreaterThan(0);
        expect(typeof schedule.state).toBe("string");
    });
});

// ===========================================================================
// (d) — preferencesOverride replaces the session mutate-restore
// ===========================================================================

describe("P2.10 (d) — preferencesOverride (no session mutation)", () => {
    const OVERRIDE: SchedulePreferences = {
        loadStyle: "frontload",
        pins: [{ courseId: "CSCI-UA 102", term: "2026-fall" }],
    };

    it("buildSolverInput uses preferencesOverride and leaves session.schedulePreferences untouched", () => {
        const session = makeFixtureSession();
        // Seed an existing (different) preferences object on the session.
        const original: SchedulePreferences = { loadStyle: "backload" };
        session.schedulePreferences = original;

        const input = buildSolverInput(session, makeFixtureDpr(), { preferencesOverride: OVERRIDE });

        // The override is what the builder used...
        expect(input.preferences?.loadStyle).toBe("frontload");
        expect(input.preferences?.pins).toHaveLength(1);
        // ...and the session was NOT mutated (same object, same value).
        expect(session.schedulePreferences).toBe(original);
        expect(session.schedulePreferences?.loadStyle).toBe("backload");
    });

    it("buildSolverInput falls back to session.schedulePreferences when no override is given", () => {
        const session = makeFixtureSession();
        session.schedulePreferences = { loadStyle: "backload" };

        const input = buildSolverInput(session, makeFixtureDpr(), {});
        expect(input.preferences?.loadStyle).toBe("backload");
    });

    it("buildSolverInputFromSession(session, dpr, P) no longer mutates session.schedulePreferences", () => {
        const session = makeFixtureSession();
        const original: SchedulePreferences = { loadStyle: "backload" };
        session.schedulePreferences = original;

        const input = buildSolverInputFromSession(session, makeFixtureDpr(), OVERRIDE);

        // The passed preferences were used as the effective preferences.
        expect(input.preferences?.loadStyle).toBe("frontload");
        // The session reference AND value are unchanged (mutate-restore is gone).
        expect(session.schedulePreferences).toBe(original);
        expect(session.schedulePreferences?.loadStyle).toBe("backload");
    });

    it("buildSolverInputFromSession leaves an UNDEFINED session.schedulePreferences undefined", () => {
        const session = makeFixtureSession();
        expect(session.schedulePreferences).toBeUndefined();

        buildSolverInputFromSession(session, makeFixtureDpr(), OVERRIDE);

        // Previously the mutate-restore wrote OVERRIDE onto the session and then
        // restored undefined; the override path never touches the session at all.
        expect(session.schedulePreferences).toBeUndefined();
    });
});
