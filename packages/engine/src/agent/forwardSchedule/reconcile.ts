/**
 * Phase 13 Task 4 — DPR reconciliation for ForwardSchedule.
 *
 * When a student uploads a new DPR, compare its courseHistory hash
 * against the one stored in the schedule. On mismatch:
 *   - specific_planned → completed  when the DPR shows EN/TE with passing grade
 *   - specific_planned → in_progress when the DPR shows IP
 *   - placeholder → removed         when its satisfiesRules[] rId is now in DPR coursesUsed
 *
 * After all slot replacements, re-run runGraduationPathValidator so
 * ForwardSchedule.state and assumptions[] stay correct.
 */

import { createHash } from "node:crypto";
import type { ForwardSchedule, ScheduleSlot, ForwardSemester } from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow } from "../../dpr/schema.js";
import { walkRequirements } from "../../dpr/schema.js";
import { meetsGradeThreshold } from "../../dpr/gradeComparison.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "./graduationPathValidator.js";
import type { GraduationPathValidatorArgs } from "./graduationPathValidator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileArgs {
    schedule: ForwardSchedule;
    newDpr: DegreeProgressReport;
    programRules: GraduationPathValidatorArgs["programRules"];
}

export interface ReconcileResult {
    /** True when the input DPR's hash differs from the schedule's stored hash. */
    hashChanged: boolean;
    /** The post-reconciliation schedule. When hashChanged=false this is the
     *  original schedule unchanged; when true it has slot replacements + a
     *  fresh state via the validator re-run. */
    schedule: ForwardSchedule;
    /** Audit trail of changes applied. */
    transformations: Array<{
        kind: "slot-completed" | "slot-in-progress" | "placeholder-removed";
        term: string;
        courseId?: string;
        rId?: string;
    }>;
}

// ---------------------------------------------------------------------------
// hashDprCourseHistory — exported for tests + ToolSession ingestion
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the DPR's courseHistory rows. Deterministic: sorts rows by
 * term + subject + catalogNbr before serializing so insertion order
 * differences don't change the hash.
 */
export function hashDprCourseHistory(dpr: DegreeProgressReport): string {
    const sorted = [...dpr.courseHistory].sort((a, b) => {
        const termCmp = a.term.localeCompare(b.term);
        if (termCmp !== 0) return termCmp;
        const subjCmp = a.subject.localeCompare(b.subject);
        if (subjCmp !== 0) return subjCmp;
        return a.catalogNbr.localeCompare(b.catalogNbr);
    });
    // Serialize only the stable identity fields (term, subject, catalogNbr,
    // grade, type, units) — not optional metadata that varies across parsers.
    const payload = sorted.map(r => ({
        term: r.term,
        subject: r.subject,
        catalogNbr: r.catalogNbr,
        grade: r.grade,
        type: r.type,
        units: r.units,
    }));
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// "completed" detection per DPR row
// ---------------------------------------------------------------------------

function isCompletedRow(row: DPRCourseRow): boolean {
    // EN and TE types with a non-null grade that passes D threshold
    if (row.type !== "EN" && row.type !== "TE") return false;
    const grade = row.grade;
    if (!grade) return false;
    // Explicitly non-passing grades — fail closed
    const upperGrade = grade.toUpperCase().trim();
    if (upperGrade === "F" || upperGrade === "W" || upperGrade === "WD") return false;
    return meetsGradeThreshold(grade, "D");
}

function isInProgressRow(row: DPRCourseRow): boolean {
    return row.type === "IP";
}

// ---------------------------------------------------------------------------
// reconcileWithDpr
// ---------------------------------------------------------------------------

export function reconcileWithDpr(args: ReconcileArgs): ReconcileResult {
    const { schedule, newDpr, programRules } = args;

    const newHash = hashDprCourseHistory(newDpr);

    if (newHash === schedule.dprCourseHistoryHash) {
        return { hashChanged: false, schedule, transformations: [] };
    }

    // Build lookup structures from the new DPR
    // courseId (e.g. "CSCI-UA 421") → DPRCourseRow
    const completedByKey = new Map<string, DPRCourseRow>();
    const inProgressByKey = new Map<string, DPRCourseRow>();
    for (const row of newDpr.courseHistory) {
        const key = `${row.subject} ${row.catalogNbr}`;
        if (isCompletedRow(row)) completedByKey.set(key, row);
        if (isInProgressRow(row)) inProgressByKey.set(key, row);
    }

    // Build a set of rIds now satisfied via DPR coursesUsed
    const satisfiedRIds = new Set<string>();
    for (const req of walkRequirements(newDpr.requirementGroups)) {
        if (req.coursesUsed.length > 0) {
            satisfiedRIds.add(req.rId);
        }
    }

    const transformations: ReconcileResult["transformations"] = [];

    // Process each semester's slots
    const newSemesters: ForwardSemester[] = schedule.semesters.map(sem => {
        const newSlots: ScheduleSlot[] = [];

        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned") {
                const courseKey = slot.courseId;
                const completedRow = completedByKey.get(courseKey);
                const ipRow = inProgressByKey.get(courseKey);

                if (completedRow) {
                    // Replace with completed slot
                    transformations.push({
                        kind: "slot-completed",
                        term: sem.term,
                        courseId: slot.courseId,
                    });
                    newSlots.push({
                        kind: "completed",
                        courseId: slot.courseId,
                        title: slot.title,
                        credits: slot.credits,
                        grade: completedRow.grade ?? "P",
                    });
                    continue;
                }

                if (ipRow) {
                    // Replace with in_progress slot
                    transformations.push({
                        kind: "slot-in-progress",
                        term: sem.term,
                        courseId: slot.courseId,
                    });
                    newSlots.push({
                        kind: "in_progress",
                        courseId: slot.courseId,
                        title: slot.title,
                        credits: slot.credits,
                    });
                    continue;
                }

                // No change
                newSlots.push(slot);

            } else if (slot.kind === "placeholder") {
                // Remove placeholder if any of its satisfiesRules is now
                // covered by a DPR coursesUsed entry
                const isNowSatisfied = slot.satisfiesRules.some(rId => satisfiedRIds.has(rId));
                if (isNowSatisfied) {
                    const satisfiedRId = slot.satisfiesRules.find(rId => satisfiedRIds.has(rId));
                    transformations.push({
                        kind: "placeholder-removed",
                        term: sem.term,
                        rId: satisfiedRId,
                    });
                    // Drop the slot — don't push it
                    continue;
                }
                newSlots.push(slot);

            } else {
                // completed or in_progress — no change
                newSlots.push(slot);
            }
        }

        // Recompute plannedCredits after slot changes
        const plannedCredits = newSlots.reduce((sum, s) => {
            if (s.kind === "specific_planned" || s.kind === "placeholder" || s.kind === "in_progress") {
                return sum + s.credits;
            }
            return sum;
        }, 0);

        return { ...sem, slots: newSlots, plannedCredits };
    });

    // Build the reconciled schedule with updated hash + semesters
    const reconciled: ForwardSchedule = {
        ...schedule,
        semesters: newSemesters,
        dprCourseHistoryHash: newHash,
    };

    // Re-run the graduation path validator to get a fresh state + update it
    const validatorResult = runGraduationPathValidator({
        plan: reconciled,
        dpr: newDpr,
        programRules,
    });
    const newState = derivePlanStateFromValidator(validatorResult, reconciled);

    const finalSchedule: ForwardSchedule = {
        ...reconciled,
        state: newState,
    };

    return { hashChanged: true, schedule: finalSchedule, transformations };
}
