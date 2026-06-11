// ============================================================
// D5.1 — checkPlanClaims plan-claim validator (LAUNCH-BLOCKING)
// ============================================================
// The exit criterion "ungrounded plan claims blocked." checkPlanClaims
// diffs the agent's prose against the stored ForwardSchedule and BLOCKS:
//   - course-placement claims that disagree with where the plan puts a
//     course (or place a course the plan doesn't),
//   - graduation-term claims that disagree with graduationTerm,
//   - lock-status claims that disagree with the stored slot's mutability.
// It is PURE (no LLM) and a no-op when ctx.forwardSchedule is absent.

import { describe, expect, it } from "vitest";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import { validateResponse } from "../../src/agent/responseValidator.js";

// ------------------------------------------------------------
// Minimal slot builders. checkPlanClaims only reads `kind` +
// `courseId` (and, for lock status, the slot kind + the semester's
// `locked`). The rich specific_planned/placeholder fields are
// irrelevant to the check, so we cast minimal shapes to ScheduleSlot.
// ------------------------------------------------------------
function plannedSlot(courseId: string): ScheduleSlot {
    return { kind: "specific_planned", courseId, title: courseId, credits: 4 } as unknown as ScheduleSlot;
}
function completedSlot(courseId: string): ScheduleSlot {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" } as unknown as ScheduleSlot;
}

// CSCI-UA 102 → specific_planned (movable) in 2027-fall (unlocked).
// CSCI-UA 101 → completed (locked/final) in 2025-fall (locked).
// CSCI-UA 201 → specific_planned (movable) in 2027-spring (unlocked).
// graduationTerm → 2028-spring.
function makeSchedule(): ForwardSchedule {
    return {
        studentId: "stu-1",
        homeSchoolId: "cas",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            {
                term: "2025-fall",
                locked: true,
                slots: [completedSlot("CSCI-UA 101")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
            {
                term: "2027-spring",
                locked: false,
                slots: [plannedSlot("CSCI-UA 201")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
            {
                term: "2027-fall",
                locked: false,
                slots: [plannedSlot("CSCI-UA 102")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
        ],
    } as unknown as ForwardSchedule;
}

function planViolations(assistantText: string, schedule?: ForwardSchedule) {
    const verdict = validateResponse({
        assistantText,
        invocations: [],
        ...(schedule ? { forwardSchedule: schedule } : {}),
    });
    return verdict.violations.filter((v) => v.kind === "ungrounded_plan_claim");
}

describe("checkPlanClaims (D5.1)", () => {
    // (a) wrong placement → exactly one violation
    it("(a) flags a course claimed in a term the plan does NOT place it", () => {
        const v = planViolations(
            "I've put CSCI-UA 102 in Spring 2026 for you.",
            makeSchedule(),
        );
        expect(v.length).toBe(1);
    });

    // (a2) prose-form term match → NO violation (normalizer works)
    it("(a2) accepts a prose term that matches the stored canonical term", () => {
        const v = planViolations(
            "CSCI-UA 102 is scheduled in Fall 2027.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // (a3) near-miss season → violation; course w/o term → no false positive
    it("(a3) flags a near-miss season and ignores a course with no term claim", () => {
        const wrongSeason = planViolations(
            "CSCI-UA 102 is in Spring 2027.",
            makeSchedule(),
        );
        expect(wrongSeason.length).toBe(1);

        const noTerm = planViolations(
            "CSCI-UA 102 is a great course and pairs well with your other classes.",
            makeSchedule(),
        );
        expect(noTerm.length).toBe(0);
    });

    // (b) grad-term mismatch → violation; match → none
    it("(b) flags a graduation-term claim that disagrees, accepts a matching one", () => {
        const wrong = planViolations(
            "Based on this plan, you graduate Fall 2028.",
            makeSchedule(),
        );
        expect(wrong.length).toBe(1);

        const right = planViolations(
            "Based on this plan, you graduate Spring 2028.",
            makeSchedule(),
        );
        expect(right.length).toBe(0);
    });

    // (c) all placements match → NO violation
    it("(c) accepts a reply whose placements all match the stored plan", () => {
        const v = planViolations(
            "CSCI-UA 102 sits in Fall 2027, and you graduate Spring 2028.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // (d) no forwardSchedule → no-op
    it("(d) is a no-op when ctx.forwardSchedule is absent", () => {
        const v = planViolations(
            "CSCI-UA 102 is in Spring 2026 and you graduate Fall 2099.",
            undefined,
        );
        expect(v.length).toBe(0);
    });

    // (e) lock-status both directions
    it("(e) flags claiming a movable slot is locked, and claiming a locked slot is movable", () => {
        // specific_planned + unlocked semester = movable; reply says it's locked/final.
        const lockedClaim = planViolations(
            "CSCI-UA 102 is locked and final — you can't change it.",
            makeSchedule(),
        );
        expect(lockedClaim.length).toBeGreaterThanOrEqual(1);

        // completed = locked/final; reply says student can still move it.
        const movableClaim = planViolations(
            "You can still move CSCI-UA 101 to a later term if you'd like.",
            makeSchedule(),
        );
        expect(movableClaim.length).toBeGreaterThanOrEqual(1);
    });

    // (f) counterfactual carve-out → NO violation
    it("(f) does NOT flag a counterfactual/hypothetical placement or grad-term claim", () => {
        const v = planViolations(
            "If you failed CSCI-UA 101, you would graduate Spring 2029 and CSCI-UA 102 would move to Spring 2028.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });
});

// ============================================================
// GUARD — fully-GROUNDED replies must NOT false-block. These are
// the worst outcome for a launch-blocking gate: blocking a TRUE,
// grounded adviser reply. Each reply below is TRUE against the
// stored plan (102 @ 2027-fall, 101 @ 2025-fall completed/locked,
// 201 @ 2027-spring, graduationTerm 2028-spring) and MUST emit
// ZERO ungrounded_plan_claim violations.
// ============================================================
describe("checkPlanClaims — grounded replies must NOT false-block", () => {
    // C1 — prereq chain: a NEIGHBOR course's term must not bind to 102.
    // 102 is in 2027-fall; 101's "Fall 2025" must NOT bind to 102.
    it("(C1) does NOT bind a neighboring prereq's term to the course", () => {
        const v = planViolations(
            "Since CSCI-UA 102 requires CSCI-UA 101 (which you finished in Fall 2025), it's placed afterward.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // C2 — cross-bind two courses: 201's "Spring 2027" must not bind to 102.
    it("(C2) does NOT cross-bind a second course's term to the first", () => {
        const v = planViolations(
            "CSCI-UA 102 builds on CSCI-UA 201 which you take in Spring 2027.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // C3 — sentence boundary: the grad term from a prior sentence must not
    // bind to 102.
    it("(C3) does NOT let a term from a prior sentence bind to the course", () => {
        const v = planViolations(
            "With this plan you graduate Spring 2028. CSCI-UA 102 is your last CS requirement.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // C4 — grad path matches a placement term: a placement term in a
    // "graduat…" clause must NOT fire the grad path.
    it("(C4) does NOT fire the grad path on a placement term in a graduate clause", () => {
        const v = planViolations(
            "To graduate on time, plan to take CSCI-UA 102 in Fall 2027.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // C5 — two courses, opposite lock status, one comma-spanning sentence:
    // 101 is final (correct), 102 can still move (correct). ZERO blocks.
    it("(C5) attributes opposite lock/movable assertions to the nearest course", () => {
        const v = planViolations(
            "CSCI-UA 101 is final, and CSCI-UA 102 can still move.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });
});

// ============================================================
// GUARD (round 2) — two more false-positive classes from adversarial
// review. Both wrongly BLOCK fully-grounded adviser replies. Every
// reply below is TRUE against the stored plan (102 @ 2027-fall movable,
// 101 @ 2025-fall completed/locked, 201 @ 2027-spring, graduationTerm
// 2028-spring) and MUST emit ZERO ungrounded_plan_claim violations.
// ============================================================
describe("checkPlanClaims — grounded replies must NOT false-block (round 2)", () => {
    // C-NEW-1 — placement path has no grad-token guard (mirror of C4).
    // A "graduat…" token strictly between a course code and a term label
    // (no period to clip on) must NOT let the GRADUATION term be read as
    // that course's PLACEMENT term. 102 is correctly in 2027-fall, grad
    // is correctly Spring 2028 — these are all grounded.
    const cNew1 = [
        "After finishing CSCI-UA 102, you graduate in Spring 2028.",
        "Take CSCI-UA 102, then graduate Spring 2028.",
        "CSCI-UA 102 is your last course before you graduate Spring 2028.",
        "You graduate Spring 2028, right after CSCI-UA 102.",
        "CSCI-UA 102 keeps you on track to graduate Spring 2028.",
        "Your final course CSCI-UA 102 leads to graduation in Spring 2028.",
    ];
    for (const reply of cNew1) {
        it(`(C-NEW-1) grad term between course and label does NOT bind as placement: ${reply}`, () => {
            const v = planViolations(reply, makeSchedule());
            expect(v.length).toBe(0);
        });
    }

    // C-NEW-2 — LOCK_ASSERT_RE over-matches the bare word "final".
    // "final course" / "final exam" / "finalized title" are NOT lock
    // assertions; 102 is movable, so reading them as a lock claim
    // false-blocks. These are all grounded.
    const cNew2 = [
        "Your final course is CSCI-UA 102 in Fall 2027.",
        "CSCI-UA 102 has a final exam in Fall 2027.",
        "CSCI-UA 102 is the finalized title for your intro course in Fall 2027.",
    ];
    for (const reply of cNew2) {
        it(`(C-NEW-2) bare-noun "final" is NOT a lock assertion: ${reply}`, () => {
            const v = planViolations(reply, makeSchedule());
            expect(v.length).toBe(0);
        });
    }

    // M-1 — DELIBERATE known limit (false-negative-preferred policy).
    // The C4/C-NEW-1 grad-exclusion means a genuinely-WRONG grad claim
    // phrased WITH a co-occurring course whose stored term equals the
    // STATED grad term slips through (stored grad is Spring 2028, but
    // "CSCI-UA 102 means you graduate Fall 2027" — 102's stored term —
    // yields 0 violations). ACCEPTABLE: false-negative > false-block.
    it("(M-1) documented known limit: wrong grad term that equals a co-occurring course's term slips", () => {
        const v = planViolations(
            "CSCI-UA 102 means you graduate Fall 2027.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });
});

// ============================================================
// GUARD (round 3) — clause-scoped NEGATION guard. A negated adviser
// sentence is NOT a lock/placement/grad assertion: "CSCI-UA 102 isn't
// locked yet" reads (pre-fix) as a lock assertion and false-blocks a
// TRUE reply. Every reply below is TRUE against the stored plan (102 @
// 2027-fall movable, 101 @ 2025-fall completed/locked, 201 @ 2027-spring,
// graduationTerm 2028-spring) and MUST emit ZERO ungrounded_plan_claim
// violations. The negation marker GOVERNS the matched token, so the
// statement disclaims — not asserts — the lock/placement/grad.
// ============================================================
describe("checkPlanClaims — negated phrasings must NOT false-block", () => {
    // Lock (negated): a negated lock or a negated movable keyword is not
    // a claim. 102 is movable; 101 is completed/locked. Each is TRUE.
    const negatedLock = [
        "CSCI-UA 102 isn't locked yet, so you can still move it.",
        "CSCI-UA 102 is not set in stone.",
        "CSCI-UA 102 is no longer locked.",
        "We haven't locked CSCI-UA 102 down.",
        "CSCI-UA 101 is not movable since it's done.",
    ];
    for (const reply of negatedLock) {
        it(`(N-lock) negated lock/movable is not a claim: ${reply}`, () => {
            const v = planViolations(reply, makeSchedule());
            expect(v.length).toBe(0);
        });
    }

    // Placement (negated): the negated placement is not a claim. Note the
    // ";"-split corrective: the clause containing "Spring 2026" is
    // "CSCI-UA 102 is not in Spring 2026", which DOES carry a governing
    // "not" before the term label → suppress.
    const negatedPlacement = [
        "CSCI-UA 102 is not in Spring 2026; it's in Fall 2027.",
        "I did not put CSCI-UA 102 in Spring 2026.",
    ];
    for (const reply of negatedPlacement) {
        it(`(N-place) negated placement is not a claim: ${reply}`, () => {
            const v = planViolations(reply, makeSchedule());
            expect(v.length).toBe(0);
        });
    }

    // Graduation (negated): the negated grad term is not a claim.
    it("(N-grad) negated graduation term is not a claim", () => {
        const v = planViolations(
            "You will not graduate in Fall 2027 as you feared.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });
});

// ============================================================
// DETECTION-SURVIVES probes — genuinely-ungrounded claims that MUST
// still fire after the round-2 tightening, so we know detection wasn't
// regressed away.
// ============================================================
describe("checkPlanClaims — genuine ungrounded claims still fire (round 2)", () => {
    it("(P1) wrong placement still fires", () => {
        const v = planViolations("CSCI-UA 102 is in Spring 2026.", makeSchedule());
        expect(v.length).toBe(1);
    });

    it("(P2) wrong grad term (no co-occurring course) still fires", () => {
        const v = planViolations("You graduate Fall 2027.", makeSchedule());
        expect(v.length).toBe(1);
    });

    it("(P3) wrong lock (movable claimed locked) still fires", () => {
        const v = planViolations("CSCI-UA 102 is final.", makeSchedule());
        expect(v.length).toBeGreaterThanOrEqual(1);
    });

    it("(P4) wrong lock (locked claimed movable) still fires", () => {
        const v = planViolations("You can still move CSCI-UA 101.", makeSchedule());
        expect(v.length).toBeGreaterThanOrEqual(1);
    });

    it("(P5) two-course sentence fires only on the genuinely-wrong lock (102)", () => {
        const v = planViolations(
            "CSCI-UA 102 is locked, and CSCI-UA 101 is final.",
            makeSchedule(),
        );
        // 102 is movable → "locked" is wrong → fires. 101 is completed/locked
        // → "final" is correct → no fire. Exactly one violation, on 102.
        expect(v.length).toBe(1);
        expect(v[0]!.detail).toContain("CSCI-UA 102");
    });
});
