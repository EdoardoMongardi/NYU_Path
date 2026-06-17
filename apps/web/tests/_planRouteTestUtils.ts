// ============================================================
// Shared fixtures + fake-request helpers for the plan-action route
// tests (Phase 17 Task B). Each per-route test file imports these
// to keep the seed boilerplate out of the per-suite assertions.
// ============================================================

import { SignJWT } from "jose";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import { getStores } from "../lib/db/store";
import { SESSION_COOKIE } from "../lib/auth/session";
import type { ForwardSchedule, ScheduleSlot, StudentProfile } from "@nyupath/shared";

export const TEST_SECRET = "test-secret-for-plan-route-tests-32+++++++++++";

export function makeDpr(): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
    };
}

export function makeProfile(studentId: string): StudentProfile {
    return {
        id: studentId,
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
}

/** Build a schedule with a single semester containing the supplied
 *  slots. Used by the move + swap suites that need to verify slot
 *  placement before/after the route runs. */
export function makeFeasibleScheduleWithSemesters(
    studentId: string,
    semesters: Array<{ term: string; slots: ScheduleSlot[] }>,
): ForwardSchedule {
    return {
        studentId,
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: semesters.map((s) => ({
            term: s.term,
            locked: false,
            slots: s.slots,
            plannedCredits: s.slots.reduce(
                (sum, sl) => sum + ("credits" in sl && typeof sl.credits === "number" ? sl.credits : 0),
                0,
            ),
            notes: [],
            loadRationale: {
                strategy: "balanced",
                creditsTarget: 16,
                slack: 0,
                weightedCredits: 0,
                hardCount: 0,
                easyCount: 0,
                alternativeDistributionsConsidered: [],
            },
        })),
        dprCourseHistoryHash: "test-hash",
        computedAt: 1700000000000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

export function makeFeasibleSchedule(studentId: string): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(studentId, []);
}

/** Build a `specific_planned` slot satisfying every required field of
 *  `ScheduleSlotSpecificPlanned`. The defaults are inert (empty arrays
 *  / no requirements); tests only consult `kind`, `courseId`, `term`,
 *  and `credits`. */
export function specificSlot(courseId: string, credits = 4): ScheduleSlot {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits,
        satisfiesRules: [],
        reason: "test fixture",
        rationale: {
            satisfiesRequirements: [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "free-elective",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

export async function seedStudentState(studentId: string, schedule?: ForwardSchedule): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    await profileStore.persistMutation(
        makeProfile(studentId),
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        makeDpr(),
    );
    await scheduleStore.persistSchedule(studentId, schedule ?? makeFeasibleSchedule(studentId), "fp-test");
}

export async function issueTestToken(sub: string): Promise<string> {
    return new SignJWT({ email: `${sub}@nyu.edu` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(TEST_SECRET));
}

export interface FakeRequest {
    cookies?: { get: (name: string) => { value: string } | undefined };
    headers: { get: (name: string) => string | null };
    json: () => Promise<unknown>;
}

export function fakeRequest(cookieValue: string | undefined, body: unknown): FakeRequest {
    return {
        cookies: cookieValue
            ? { get: (n: string) => (n === SESSION_COOKIE ? { value: cookieValue } : undefined) }
            : { get: () => undefined },
        headers: { get: () => null },
        json: async () => body,
    };
}
