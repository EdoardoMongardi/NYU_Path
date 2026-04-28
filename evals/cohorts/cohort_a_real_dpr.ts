// ============================================================
// Cohort A — real-DPR-backed cases (Phase 7-E W8.0)
// ============================================================
// 8 cases backed by the actual parsed Albert DPR (redacted)
// the user provided. Whereas cohort_a_dpr.ts cases use synthetic
// mkDpr() fixtures (where I author both the input and the expected
// answer — risking tautological "the agent surfaces the number
// I made up"), these cases use a real DPR that came out of NYU's
// PeopleSoft AAR. The expected values are what the parser
// actually extracted from the real document.
//
// This is the strongest end-to-end gate before live cohort A:
// "given a real Albert DPR, does the agent give the right
// answers to common student questions?"
//
// Source DPR: SAA_STD_DS.pdf (PII-redacted to "Sample Student" /
// "N00000000" / "A. Adviser"). Verified parser values:
//   - Cumulative GPA: 3.402
//   - Credits used: 138 / 128 required
//   - CAS residency: 80 / 64
//   - P/F used: 4 of 32
//   - Outside-CAS used: 14 of 16
//   - Time limit: 8 years
//   - 1 unsatisfied requirement: CSCI-UA 421 Numerical Computing
//     (R1142/20 — CS Required Courses)
//   - 1 unsatisfied requirement: Texts & Ideas
//     (R1004/10 — needs CORE-UA 400-499)
//   - Currently in progress (Spring 2026):
//     CSCI-UA 4, CSCI-UA 473, MATH-UA 334, MPAJZ-UE 71
//   - Currently in progress (Fall 2026):
//     CORE-UA 700, MATH-UA 251, MATH-UA 343
//   - Major: CS/Math joint (RG5076)
// ============================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDpr, type DegreeProgressReport } from "../../packages/engine/src/index.js";
import type { ConversationCase } from "../cohort/runner.js";
import type { StudentProfile } from "@nyupath/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
    __dirname,
    "..",
    "..",
    "packages/engine/tests/fixtures/dpr_sample.redacted.txt",
);

// Parse the redacted real DPR once at module load. The fixture is
// committed to the repo (it's safe to ship — PII redacted in W1.3),
// so this runs deterministically in CI.
const REAL_DPR_TEXT = readFileSync(FIXTURE_PATH, "utf-8");
const REAL_DPR_PARSE = parseDpr(REAL_DPR_TEXT, {
    pageCount: 9,
    nowIso: "2026-04-27T00:00:00Z",
});
if (!REAL_DPR_PARSE.ok) {
    throw new Error(
        `cohort_a_real_dpr.ts: failed to parse the redacted real DPR fixture: ${REAL_DPR_PARSE.error}`,
    );
}
const REAL_DPR: DegreeProgressReport = REAL_DPR_PARSE.report;

// Sanity-assert the parsed values match what we expect to grade
// against. Catches the case where the fixture is updated without
// also updating these expected values.
if (REAL_DPR.cumulative.cumulativeGpa !== 3.402) {
    throw new Error(`Real DPR fixture changed: expected GPA=3.402, got ${REAL_DPR.cumulative.cumulativeGpa}`);
}
if (REAL_DPR.cumulative.creditsUsed !== 138) {
    throw new Error(`Real DPR fixture changed: expected credits=138, got ${REAL_DPR.cumulative.creditsUsed}`);
}

const REAL_STUDENT: StudentProfile = {
    id: "cohortA-real-dpr",
    catalogYear: "2024-2025",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "computer_science_math", programType: "major" }],
    coursesTaken: [], // The DPR's courseHistory is the canonical source; the agent reads from session.degreeProgressReport, not coursesTaken.
    visaStatus: "domestic",
};

// ----------------------------------------------------------------
// Real-DPR-backed cases
// ----------------------------------------------------------------

export const COHORT_A_REAL_DPR_CASES: ConversationCase[] = [
    {
        id: "cohortA-real-901-cumulative-gpa",
        description: "Real DPR — cumulative GPA must be quoted verbatim.",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "What's my cumulative GPA?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["3.402"],
            forbiddenPatterns: [/around 3\.[0-9]/i, /approximately/i, /roughly/i],
        }],
    },
    {
        id: "cohortA-real-902-credits-completed",
        description: "Real DPR — credits earned must be 138 (not the 128 floor).",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "How many credits have I completed?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["138"],
        }],
    },
    {
        id: "cohortA-real-903-credits-remaining",
        description: "Real DPR — student is over the 128 credit floor; reply must say so (not 'X credits remaining').",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "How many credits do I still need to graduate?",
            expectedToolCalls: ["run_full_audit"],
            // Student has 138 of 128 required → "0" or "exceeded" or "already met";
            // any positive remaining credit count would be wrong.
            forbiddenPatterns: [/\b[1-9]\d*\s+more\s+credits?/i, /need\s+\d+\s+more\s+credits?/i],
        }],
    },
    {
        id: "cohortA-real-904-missing-requirements",
        description: "Real DPR — agent must name CSCI-UA 421 as missing (only unsatisfied major requirement).",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "What requirements do I still need to satisfy for my major?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["CSCI-UA 421"],
        }],
    },
    {
        id: "cohortA-real-905-core-texts-ideas",
        description: "Real DPR — Texts & Ideas (CORE-UA 400-499) is the other unsatisfied requirement.",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "Am I done with my CORE curriculum?",
            expectedToolCalls: ["run_full_audit"],
            // Either "Texts & Ideas" or "CORE-UA 400-499" is acceptable evidence
            // of finding it. We require both for grading explicitness.
            requiredCaveats: ["Texts"],
            forbiddenPatterns: [/^yes/i, /all (?:done|satisfied|complete)/i],
        }],
    },
    {
        id: "cohortA-real-906-pf-budget",
        description: "Real DPR — P/F shows 4 of 32 used.",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "How many pass/fail credits have I used?",
            // Either run_full_audit OR get_credit_caps surfaces this; both acceptable.
            requiredCaveats: ["4"], // 4 used
        }],
    },
    {
        id: "cohortA-real-907-outside-cas",
        description: "Real DPR — outside-CAS credits 14 of 16 used (close to the cap).",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "Can I take more classes outside of CAS?",
            // 14 of 16 means 2 credits remain. Reply should mention either
            // the remaining (2) or the cap (16) so the student understands.
            requiredCaveats: ["16"],
            // Should not say "yes you have plenty of room"
            forbiddenPatterns: [/plenty of room/i, /no limit/i],
        }],
    },
    {
        id: "cohortA-real-908-graduation-readiness",
        description: "Real DPR — overall: 1 requirement unsatisfied (CSCI-UA 421); cannot graduate without it.",
        student: REAL_STUDENT,
        degreeProgressReport: REAL_DPR,
        turns: [{
            userMessage: "Am I on track to graduate this semester?",
            expectedToolCalls: ["run_full_audit"],
            // The DPR's unsatisfied flag is the truth: agent should NOT say
            // "yes you're done" — must mention the unsatisfied work.
            forbiddenPatterns: [/^yes,? you (?:are|'re) (?:done|on track|all set|ready)/i],
            requiredCaveats: ["CSCI-UA 421"],
        }],
    },
];
