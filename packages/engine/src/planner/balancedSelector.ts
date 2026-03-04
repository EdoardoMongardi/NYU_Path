// ============================================================
// Balanced Selector — Credit-aware pacing across semesters
// ============================================================
import type {
    PlannerConfig,
    CourseSuggestion,
    RuleAuditResult,
    Course,
} from "@nyupath/shared";

export interface BalancedSelection {
    /** Final ordered list of course suggestions */
    suggestions: CourseSuggestion[];
    /** Credits planned this semester */
    plannedCredits: number;
    /** Free elective slots remaining (after required + needed electives) */
    freeSlots: number;
    /** How many required courses were selected this semester */
    requiredThisSemester: number;
    /** How many elective slots the pacing computed for this semester */
    electiveSlots: number;
    /** Pacing context (for UI display) */
    pacingNote?: string;
}

interface ScoredCandidate {
    courseId: string;
    course: Course;
    score: number;
    reason: string;
    blockedCount: number;
    satisfiesRules: string[];
}

/**
 * Credit-aware balanced selection.
 *
 * When `targetGraduation` is set, computes a full graduation pacing plan:
 *
 * 1. Count remaining required courses from audit
 * 2. Calculate remaining Fall/Spring semesters to graduation
 * 3. requiredThisSemester = ceil(totalRequired / remainingSemesters)
 *    → e.g. 7 required / 4 semesters = 2,2,2,1 distribution
 * 4. Calculate creditsNeeded = totalCreditsRequired - creditsCompleted
 * 5. Calculate minCreditsPerSemester = ceil(creditsNeeded / remainingSemesters)
 * 6. If minCreditsPerSemester ≤ 12: student is safely on track.
 *    Required + electives fill up to 12 (or student's chosen maxCredits).
 *    Additional electives are optional (up to 18).
 * 7. If minCreditsPerSemester > 12: student needs extra electives to graduate.
 *    Fill to minCreditsPerSemester.
 *
 * Without `targetGraduation`: falls back to greedy (fill all required first).
 * Final semester (1 left): skip pacing, pack everything.
 */
export function balancedSelect(
    scored: ScoredCandidate[],
    auditRules: RuleAuditResult[],
    config: PlannerConfig,
    remainingSemesters: number,
    creditsCompleted?: number,
    totalCreditsRequired?: number,
    visaStatus?: "f1" | "domestic" | "other"
): BalancedSelection {
    const relevantScored = scored.filter(s => s.satisfiesRules.length > 0);
    const otherScored = scored.filter(s => s.satisfiesRules.length === 0);

    // No targetGraduation → greedy mode (original behavior)
    if (!config.targetGraduation) {
        return greedySelect(relevantScored, otherScored, config);
    }

    // Count remaining required courses across unmet rules
    const totalRequiredRemaining = auditRules.reduce((sum, rule) => {
        if (rule.status === "satisfied") return sum;
        return sum + rule.remaining;
    }, 0);

    // Count Fall/Spring semesters remaining
    const semestersToGrad = countFallSpringSemesters(
        config.targetSemester,
        config.targetGraduation
    );
    const effectiveSemesters = Math.max(1, semestersToGrad);

    // Final semester override: pack everything
    if (effectiveSemesters <= 1) {
        return greedySelect(relevantScored, otherScored, config);
    }

    // --- Pacing Logic ---
    const requiredCap = Math.ceil(totalRequiredRemaining / effectiveSemesters);

    // Credit pacing
    const credDone = creditsCompleted ?? 0;
    const credTotal = totalCreditsRequired ?? 128;
    const creditsNeeded = Math.max(0, credTotal - credDone);
    const minCreditsPerSemester = Math.ceil(creditsNeeded / effectiveSemesters);

    // F-1 students: hard floor at 12 credits/semester (unless final semester, handled above)
    // Domestic students: no floor — can take as few credits as graduation pacing requires
    const isF1 = visaStatus === "f1";
    const creditFloor = isF1 ? 12 : minCreditsPerSemester;

    const semesterTarget = Math.min(
        config.maxCredits,
        Math.max(creditFloor, minCreditsPerSemester)
    );

    let pacingNote: string;
    if (minCreditsPerSemester <= 12) {
        if (isF1) {
            pacingNote = `On track: ${creditsNeeded} credits remaining across ${effectiveSemesters} semesters ` +
                `(${minCreditsPerSemester} credits/semester for graduation). ` +
                `F-1 visa requires 12 credits minimum — electives will fill to 12.`;
        } else {
            pacingNote = `On track: ${creditsNeeded} credits remaining across ${effectiveSemesters} semesters ` +
                `(${minCreditsPerSemester} credits/semester needed). ` +
                `Additional electives are optional.`;
        }
    } else {
        pacingNote = `Needs attention: ${creditsNeeded} credits remaining across ${effectiveSemesters} semesters ` +
            `(${minCreditsPerSemester} credits/semester needed, above 12-credit minimum). ` +
            `Free electives are recommended to stay on track.`;
    }

    // --- Selection ---
    const selected: CourseSuggestion[] = [];
    let plannedCredits = 0;
    let requiredCount = 0;

    // Pass 1: Required courses (capped by pacing)
    for (const s of relevantScored) {
        if (selected.length >= config.maxCourses) break;
        if (requiredCount >= requiredCap) break;
        if (plannedCredits + s.course.credits > config.maxCredits) continue;
        selected.push({
            courseId: s.courseId,
            title: s.course.title,
            credits: s.course.credits,
            reason: s.reason,
            priority: s.score,
            blockedCount: s.blockedCount,
            satisfiesRules: s.satisfiesRules,
            category: "required",
        });
        plannedCredits += s.course.credits;
        requiredCount++;
    }

    // Pass 2: Electives fill to semesterTarget
    for (const s of otherScored) {
        if (selected.length >= config.maxCourses) break;
        if (plannedCredits >= semesterTarget) break;
        if (plannedCredits + s.course.credits > config.maxCredits) continue;
        selected.push({
            courseId: s.courseId,
            title: s.course.title,
            credits: s.course.credits,
            reason: s.reason,
            priority: s.score,
            blockedCount: s.blockedCount,
            satisfiesRules: s.satisfiesRules,
            category: "elective",
        });
        plannedCredits += s.course.credits;
    }

    // Pass 3: If still under semesterTarget and no more electives,
    // spill additional required courses (better to be ahead on required)
    if (plannedCredits < semesterTarget) {
        for (const s of relevantScored) {
            if (selected.length >= config.maxCourses) break;
            if (plannedCredits >= semesterTarget) break;
            if (selected.some(sel => sel.courseId === s.courseId)) continue;
            if (plannedCredits + s.course.credits > config.maxCredits) continue;
            selected.push({
                courseId: s.courseId,
                title: s.course.title,
                credits: s.course.credits,
                reason: s.reason,
                priority: s.score,
                blockedCount: s.blockedCount,
                satisfiesRules: s.satisfiesRules,
                category: "required",
            });
            plannedCredits += s.course.credits;
            requiredCount++;
        }
    }

    const freeSlots = Math.max(0, config.maxCourses - selected.length);
    const electiveSlots = Math.max(0, config.maxCourses - requiredCap);

    return {
        suggestions: selected,
        plannedCredits,
        freeSlots,
        requiredThisSemester: requiredCount,
        electiveSlots,
        pacingNote,
    };
}

/**
 * Original greedy behavior: fill all required first, then electives.
 */
function greedySelect(
    relevantScored: ScoredCandidate[],
    otherScored: ScoredCandidate[],
    config: PlannerConfig
): BalancedSelection {
    const selected: CourseSuggestion[] = [];
    let plannedCredits = 0;
    let requiredCount = 0;

    for (const s of relevantScored) {
        if (selected.length >= config.maxCourses) break;
        if (plannedCredits + s.course.credits > config.maxCredits) continue;
        selected.push({
            courseId: s.courseId,
            title: s.course.title,
            credits: s.course.credits,
            reason: s.reason,
            priority: s.score,
            blockedCount: s.blockedCount,
            satisfiesRules: s.satisfiesRules,
            category: "required",
        });
        plannedCredits += s.course.credits;
        requiredCount++;
    }

    for (const s of otherScored) {
        if (selected.length >= config.maxCourses) break;
        if (plannedCredits + s.course.credits > config.maxCredits) continue;
        selected.push({
            courseId: s.courseId,
            title: s.course.title,
            credits: s.course.credits,
            reason: s.reason,
            priority: s.score,
            blockedCount: s.blockedCount,
            satisfiesRules: s.satisfiesRules,
            category: "elective",
        });
        plannedCredits += s.course.credits;
    }

    return {
        suggestions: selected,
        plannedCredits,
        freeSlots: Math.max(0, config.maxCourses - selected.length),
        requiredThisSemester: requiredCount,
        electiveSlots: Math.max(0, config.maxCourses - requiredCount),
    };
}

/**
 * Count remaining Fall and Spring semesters between current and target.
 * Summer and January are NOT counted for pacing.
 */
function countFallSpringSemesters(current: string, target: string): number {
    const [currentYear, currentTerm] = current.split("-");
    const targetOrd = semesterToOrdinal(target);

    let count = 0;
    let year = parseInt(currentYear, 10);
    const terms = ["spring", "fall"] as const;

    // Determine next term after current
    let termIndex: number;
    if (currentTerm === "fall") {
        year++;
        termIndex = 0; // next is spring of next year
    } else if (currentTerm === "spring") {
        termIndex = 1; // next is fall of same year
    } else {
        // summer or january → next regular semester
        termIndex = currentTerm === "summer" ? 1 : 0;
        if (currentTerm === "january") {
            termIndex = 0; // next is spring of same year
        }
    }

    while (true) {
        const sem = `${year}-${terms[termIndex]}`;
        const ord = semesterToOrdinal(sem);
        if (ord > targetOrd) break;
        count++;
        if (termIndex === 0) {
            termIndex = 1;
        } else {
            termIndex = 0;
            year++;
        }
        if (count > 20) break;
    }

    return count;
}

function semesterToOrdinal(semester: string): number {
    const [yearStr, term] = semester.split("-");
    const year = parseInt(yearStr, 10);
    const termOffset = term === "january" ? 1 : term === "spring" ? 2 : term === "summer" ? 3 : 4;
    return year * 4 + termOffset;
}
