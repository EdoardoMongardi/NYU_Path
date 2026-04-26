// ============================================================
// Multi-Semester Projector (Phase 3 §12.6 row 3)
// ============================================================
// Projects a student's degree path forward N semesters by repeatedly
// invoking `planNextSemester`, treating each suggested-course block
// as "completed with B" for the next iteration. The output is a list
// of per-semester plans plus a graduation-feasibility summary.
//
// Pure: never mutates the input profile. Each iteration uses a deep
// clone with the previous round's selections injected as B-graded
// completions. The B grade is a heuristic: the planner needs SOME
// grade to count the course as satisfying a prereq downstream, and
// "B" is a plausible default per CAS bulletin's grade scale (line 344).
// ============================================================

import type {
    Course,
    Prerequisite,
    Program,
    SchoolConfig,
    SemesterPlan,
    StudentProfile,
} from "@nyupath/shared";
import { planNextSemester } from "./semesterPlanner.js";

export type PlannerMode = "default" | "exploratory" | "transfer_prep";

export interface MultiSemesterRequest {
    student: StudentProfile;
    program: Program;
    courses: Course[];
    prereqs: Prerequisite[];
    /** First semester to plan (e.g., "2025-fall") */
    startSemester: string;
    /** How many semesters to project forward, inclusive of start. */
    semesterCount: number;
    /** Planner mode (default | exploratory | transfer_prep) */
    mode?: PlannerMode;
    /** Per-semester max courses (default 5) */
    maxCoursesPerSemester?: number;
    /** Per-semester max credits (default 18) */
    maxCreditsPerSemester?: number;
    /** Optional SchoolConfig — flows into degreeAudit's grade thresholds */
    schoolConfig?: SchoolConfig | null;
    /** Override the assumed grade for projected courses (default "B") */
    assumedGrade?: string;
}

export interface ProjectedSemester {
    /** Semester label, e.g., "2025-fall" */
    semester: string;
    plan: SemesterPlan;
    /** Cumulative credit total at the END of this semester */
    cumulativeCreditsAtEnd: number;
    /** True when the projected total credits ≥ program total at end */
    onTrackForGraduation: boolean;
}

export interface MultiSemesterResult {
    semesters: ProjectedSemester[];
    /** Earliest semester whose `onTrackForGraduation` is true, or undefined */
    projectedGraduationSemester?: string;
    /** Notes accumulated across the projection */
    notes: string[];
}

/**
 * Project the next N semesters by repeatedly running `planNextSemester`
 * and folding each plan's suggestions back into the student profile as
 * "completed-with-assumedGrade". Stops early if a semester returns zero
 * suggestions (the student has run out of unlocked, useful courses).
 */
export function projectMultiSemester(req: MultiSemesterRequest): MultiSemesterResult {
    const notes: string[] = [];
    const semesters: ProjectedSemester[] = [];
    const assumedGrade = req.assumedGrade ?? "B";
    const maxCourses = req.maxCoursesPerSemester ?? 5;
    const maxCredits = req.maxCreditsPerSemester ?? 18;

    // The projector advances Fall→Spring→Fall only. Accepting a summer or
    // january start would silently fold those courses into a fall plan;
    // surface the constraint explicitly instead.
    const startSeason = req.startSemester.match(/^\d{4}-(fall|spring|summer|january)$/i)?.[1]?.toLowerCase();
    if (!startSeason) {
        throw new Error(
            `projectMultiSemester: invalid startSemester "${req.startSemester}". ` +
            `Expected "YYYY-fall" or "YYYY-spring".`,
        );
    }
    if (startSeason === "summer" || startSeason === "january") {
        throw new Error(
            `projectMultiSemester: startSemester must be "fall" or "spring" — got "${startSeason}". ` +
            `The projector advances Fall→Spring→Fall only.`,
        );
    }

    let working: StudentProfile = JSON.parse(JSON.stringify(req.student));

    let cursor = req.startSemester;
    for (let i = 0; i < req.semesterCount; i++) {
        const plan = planNextSemester(working, req.program, req.courses, req.prereqs, {
            targetSemester: cursor,
            maxCourses,
            maxCredits,
        });

        const cumulativeAtEnd = plan.projectedTotalCredits;
        const onTrack = cumulativeAtEnd >= req.program.totalCreditsRequired;
        semesters.push({
            semester: cursor,
            plan,
            cumulativeCreditsAtEnd: cumulativeAtEnd,
            onTrackForGraduation: onTrack,
        });

        if (plan.suggestions.length === 0) {
            notes.push(
                `Projection halted at ${cursor}: planner returned zero suggestions. ` +
                `Either all degree requirements are satisfied or no unlocked courses remain.`,
            );
            break;
        }

        // Halt when graduation is reached. Without this, planNextSemester
        // keeps surfacing "available elective" filler indefinitely, projecting
        // students to 200+ credits and breaking "when do I graduate?" answers.
        // The check is post-fold so the semester containing the final
        // graduation-completing courses still appears in the output.
        if (onTrack) {
            notes.push(
                `Projection halted at ${cursor}: cumulative credits (${cumulativeAtEnd}) ` +
                `meet the ${req.program.totalCreditsRequired}-credit degree requirement.`,
            );
            // Fold this semester's suggestions in so subsequent state is consistent,
            // then break before scheduling the next semester.
            for (const s of plan.suggestions) {
                working.coursesTaken.push({
                    courseId: s.courseId,
                    grade: assumedGrade,
                    semester: cursor,
                    credits: s.credits,
                });
            }
            break;
        }

        // Fold this semester's suggestions into `working` as completed
        for (const s of plan.suggestions) {
            working.coursesTaken.push({
                courseId: s.courseId,
                grade: assumedGrade,
                semester: cursor,
                credits: s.credits,
            });
        }

        cursor = nextSemesterAfter(cursor);
    }

    const projectedGraduationSemester =
        semesters.find((s) => s.onTrackForGraduation)?.semester;

    if (req.mode) notes.unshift(`Projection mode: ${req.mode}.`);
    notes.push(
        `Assumed grade for projected courses: "${assumedGrade}". ` +
        `Real grades will affect satisfaction of grade-floor rules (CAS major: ≥C; CAS Core: ≥D).`,
    );

    return { semesters, projectedGraduationSemester, notes };
}

// ---- helpers ----

const SEASONS = ["fall", "spring"] as const;

/**
 * Step from one Fall/Spring semester to the next. Summer / January are
 * intentionally NOT included — at v3 the projector advances Fall→Spring→Fall
 * only, which matches NYU's full-time enrollment cycle.
 */
function nextSemesterAfter(semester: string): string {
    const m = semester.match(/^(\d{4})-(fall|spring|summer|january)$/i);
    if (!m) return semester;
    const year = Number(m[1]);
    const season = m[2]!.toLowerCase();
    if (season === "fall") return `${year + 1}-spring`;
    if (season === "spring") return `${year}-fall`;
    if (season === "january" || season === "summer") return `${year}-fall`;
    return semester;
}

export { nextSemesterAfter };
