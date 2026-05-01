// ============================================================
// mkDpr — DPR fixture builder for tests (Phase 7-E W5.1)
// ============================================================
// Builds `DegreeProgressReport` objects with overrides for the
// fields each test needs to vary. Lets W5 migrate the
// audit/planner/whatif test stack from "construct a Program +
// courses + studentprofile triple" to "construct a DPR" without
// boilerplate.
//
// Default-builds a minimal CAS undergrad DPR (1 program, 1
// requirement-group, satisfied state, no advisor notations).
// Tests override specific fields:
//
//   const dpr = mkDpr({
//       programs: [{ programType: "Major Approved", label: "Computer Science" }],
//       cumulative: { creditsUsed: 64, cumulativeGpa: 3.4 },
//       requirementGroups: [
//           mkGroup({ rgId: "RG_CS_MAJOR", title: "CS Major", status: "not_satisfied",
//               children: [
//                   mkRequirement({ rId: "R_CS_REQ", title: "CS Required",
//                       status: "not_satisfied",
//                       counter: { kind: "courses", required: 6, used: 5, needed: 1 },
//                       coursesUsed: [...]
//                   }),
//               ]
//           }),
//       ],
//   });
// ============================================================

import { createHash } from "node:crypto";
import {
    type DegreeProgressReport,
    type DPRAdvisorNotation,
    type DPRCounter,
    type DPRCourseRow,
    type DPRCumulative,
    type DPRHeader,
    type DPRProgram,
    type DPRRequirement,
    type DPRRequirementGroup,
    type DPRStatus,
} from "../../src/dpr/schema.js";

// ---- Defaults ----

const DEFAULT_HEADER: DPRHeader = {
    studentName: "Test Student",
    preparedDate: "04/27/2026",
};

const DEFAULT_PROGRAMS: DPRProgram[] = [
    {
        programType: "Undergraduate Career",
        label: "Undergraduate Career",
        requirementTerm: "Fall 2023",
        requirementStatus: "satisfied",
    },
    {
        programType: "Major Approved",
        label: "Computer Science",
        requirementTerm: "Fall 2024",
        requirementStatus: "satisfied",
    },
];

const DEFAULT_CUMULATIVE: DPRCumulative = {
    creditsRequired: 128,
    creditsUsed: 128,
    cumulativeGpa: 3.5,
    cumulativeGpaRequired: 2.0,
    residencyRequired: 64,
    residencyUsed: 64,
    passFailUsedUnits: 0,
    passFailCapUnits: 32,
    outsideHomeUsedUnits: 0,
    outsideHomeCapUnits: 16,
    timeLimitYears: 8,
};

// ---- Builders ----

export interface MkRequirementInput {
    rId: string;
    title?: string;
    status?: DPRStatus;
    statusText?: string;
    description?: string;
    counter?: DPRCounter;
    coursesUsed?: DPRCourseRow[];
}

export function mkRequirement(input: MkRequirementInput): DPRRequirement {
    const status = input.status ?? "satisfied";
    return {
        rId: input.rId,
        title: input.title ?? input.rId,
        status,
        statusText:
            input.statusText
            ?? (status === "satisfied"
                ? `Satisfied: ${input.title ?? input.rId} complete.`
                : `Not Satisfied: ${input.title ?? input.rId} incomplete.`),
        ...(input.description ? { description: input.description } : {}),
        ...(input.counter ? { counter: input.counter } : {}),
        coursesUsed: input.coursesUsed ?? [],
    };
}

export interface MkGroupInput {
    rgId: string;
    title?: string;
    status?: DPRStatus;
    statusText?: string;
    description?: string;
    children?: Array<DPRRequirementGroup | DPRRequirement>;
}

export function mkGroup(input: MkGroupInput): DPRRequirementGroup {
    const status = input.status ?? "satisfied";
    return {
        rgId: input.rgId,
        title: input.title ?? input.rgId,
        status,
        statusText:
            input.statusText
            ?? (status === "satisfied"
                ? `Satisfied: ${input.title ?? input.rgId} complete.`
                : `Not Satisfied: ${input.title ?? input.rgId} incomplete.`),
        ...(input.description ? { description: input.description } : {}),
        children: input.children ?? [],
    };
}

export interface MkCourseInput {
    term: string;
    courseId: string; // "CSCI-UA 102"
    grade?: string | null;
    units?: number;
    type?: string; // EN | TE | IP
    repeatCode?: string;
    courseTitle?: string;
}

export function mkCourse(input: MkCourseInput): DPRCourseRow {
    const parts = input.courseId.split(/\s+/);
    const subject = parts[0] ?? "DEPT-XX";
    const catalogNbr = parts[1] ?? "0";
    return {
        term: input.term,
        subject,
        catalogNbr,
        courseTitle: input.courseTitle ?? `${input.courseId} Title`,
        grade: input.grade === undefined ? "A" : input.grade,
        units: input.units ?? 4,
        type: input.type ?? "EN",
        ...(input.repeatCode ? { repeatCode: input.repeatCode } : {}),
    };
}

export interface MkDprInput {
    header?: Partial<DPRHeader>;
    programs?: DPRProgram[];
    advisorNotations?: DPRAdvisorNotation[];
    cumulative?: Partial<DPRCumulative>;
    requirementGroups?: DPRRequirementGroup[];
    courseHistory?: DPRCourseRow[];
    /** Override `_meta.warnings` (defaults to empty). */
    warnings?: string[];
    /** Pin the parsedAt timestamp for deterministic snapshots. */
    parsedAt?: string;
}

export function mkDpr(input: MkDprInput = {}): DegreeProgressReport {
    const header: DPRHeader = { ...DEFAULT_HEADER, ...input.header };
    const programs = input.programs ?? DEFAULT_PROGRAMS;
    const cumulative: DPRCumulative = { ...DEFAULT_CUMULATIVE, ...input.cumulative };
    const courseHistory = input.courseHistory ?? [];
    const requirementGroups = input.requirementGroups ?? [];
    const advisorNotations = input.advisorNotations ?? [];
    const warnings = input.warnings ?? [];

    // Stable fingerprint that varies with content so two distinct
    // fixtures don't collide.
    const fingerprintSource = JSON.stringify({
        header,
        programs,
        cumulative,
        rgIds: requirementGroups.map((g) => g.rgId),
        courseHistory: courseHistory.map((c) => `${c.subject}${c.catalogNbr}${c.term}`),
    });
    const fingerprint = "sha256:" + createHash("sha256").update(fingerprintSource).digest("hex");

    return {
        _meta: {
            parserVersion: "1.0.0-mkdpr",
            parsedAt: input.parsedAt ?? "2026-04-27T00:00:00Z",
            sourceFingerprint: fingerprint,
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings,
        },
        header,
        programs,
        advisorNotations,
        cumulative,
        requirementGroups,
        courseHistory,
    };
}

// ---- Common patterns (sugar for tests) ----

/**
 * Build a "graduating senior, 1 requirement remaining" DPR fixture.
 * Used by tests that need a near-grad student to exercise the
 * "what's left" question.
 */
export function mkAlmostDoneDpr(): DegreeProgressReport {
    return mkDpr({
        cumulative: {
            creditsUsed: 124,
            cumulativeGpa: 3.4,
        },
        requirementGroups: [
            mkGroup({
                rgId: "RG_MAJOR",
                title: "Computer Science Major",
                status: "not_satisfied",
                children: [
                    mkRequirement({
                        rId: "R_MAJOR_REQ",
                        title: "Computer Science: Required Courses",
                        status: "not_satisfied",
                        statusText: "Not Satisfied: Complete CSCI-UA 421 Numerical Computing.",
                        counter: { kind: "courses", required: 6, used: 5, needed: 1 },
                        coursesUsed: [
                            mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 102", grade: "B" }),
                            mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 201", grade: "B+" }),
                            mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 202", grade: "A" }),
                            mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 101", grade: "TE", type: "TE" }),
                            mkCourse({ term: "2025 Spr", courseId: "CSCI-UA 310", grade: "B+" }),
                        ],
                    }),
                ],
            }),
        ],
        courseHistory: [
            mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 102", grade: "B" }),
            mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 201", grade: "B+" }),
            mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 101", grade: "TE", type: "TE" }),
            mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 202", grade: "A" }),
            mkCourse({ term: "2025 Spr", courseId: "CSCI-UA 310", grade: "B+" }),
        ],
    });
}

/**
 * Build a "satisfied across the board" DPR fixture. For tests that
 * want a happy path.
 */
export function mkSatisfiedDpr(): DegreeProgressReport {
    return mkDpr({
        requirementGroups: [
            mkGroup({
                rgId: "RG_MAJOR",
                title: "Computer Science Major",
                status: "satisfied",
                children: [
                    mkRequirement({
                        rId: "R_MAJOR_REQ",
                        title: "Computer Science: Required Courses",
                        status: "satisfied",
                        counter: { kind: "courses", required: 6, used: 6 },
                    }),
                ],
            }),
        ],
    });
}
