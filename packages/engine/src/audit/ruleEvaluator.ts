// ============================================================
// Rule Evaluator — Evaluates individual rules against student
// ============================================================
import type {
    Rule,
    MustTakeRule,
    ChooseNRule,
    MinCreditsRule,
    MinLevelRule,
    RuleAuditResult,
    RuleStatus,
    Course,
} from "@nyupath/shared";
import { EquivalenceResolver } from "../equivalence/equivalenceResolver.js";

/**
 * Evaluate a single rule against a student's completed courses.
 * Returns the audit result for that rule.
 *
 * @param rule - The rule to evaluate
 * @param completedCourses - Normalized set of completed course IDs
 * @param courseCatalog - Map of all courses by ID
 * @param equivalence - Cross-listing resolver
 * @param declaredPrograms - Student's declared programs (for conditional exemptions)
 * @param studentFlags - Student's flags (for flag-based exemptions)
 */
export function evaluateRule(
    rule: Rule,
    completedCourses: Set<string>,
    courseCatalog: Map<string, Course>,
    equivalence: EquivalenceResolver,
    declaredPrograms: string[] = [],
    studentFlags: string[] = []
): RuleAuditResult {
    // Check conditional exemptions BEFORE evaluating the rule
    if (isExempt(rule, declaredPrograms, studentFlags)) {
        return {
            ruleId: rule.ruleId,
            label: rule.label,
            status: "satisfied",
            coursesSatisfying: [],
            remaining: 0,
            coursesRemaining: [],
            exemptReason: rule.exemptionLabel ?? "Exempt",
        };
    }

    switch (rule.type) {
        case "must_take":
            return evaluateMustTake(rule, completedCourses, equivalence);
        case "choose_n":
            return evaluateChooseN(rule, completedCourses, courseCatalog, equivalence);
        case "min_credits":
            return evaluateMinCredits(rule, completedCourses, courseCatalog, equivalence);
        case "min_level":
            return evaluateMinLevel(rule, completedCourses, courseCatalog, equivalence);
        default:
            throw new Error(`Unknown rule type: ${(rule as Rule).type}`);
    }
}

/**
 * Check if a rule is exempt based on the student's programs or flags.
 */
function isExempt(rule: Rule, declaredPrograms: string[], studentFlags: string[]): boolean {
    if (rule.conditionalExemption?.length) {
        const hasExemptProgram = rule.conditionalExemption.some(p => declaredPrograms.includes(p));
        if (hasExemptProgram) return true;
    }
    if (rule.flagExemption?.length) {
        const hasExemptFlag = rule.flagExemption.some(f => studentFlags.includes(f));
        if (hasExemptFlag) return true;
    }
    return false;
}

/** Check if a course matches any pattern in a pool (supports * wildcards) */
function matchesPool(courseId: string, pool: string[], equivalence: EquivalenceResolver): boolean {
    const canonical = equivalence.getCanonical(courseId);
    return pool.some(pattern => {
        if (pattern.includes("*")) {
            const prefix = pattern.replace("*", "");
            return courseId.startsWith(prefix) || canonical.startsWith(prefix);
        }
        return equivalence.getCanonical(pattern) === canonical;
    });
}

function evaluateMustTake(
    rule: MustTakeRule,
    completedCourses: Set<string>,
    equivalence: EquivalenceResolver
): RuleAuditResult {
    const satisfying: string[] = [];
    const remaining: string[] = [];

    for (const courseId of rule.courses) {
        if (equivalence.isInSet(courseId, completedCourses)) {
            satisfying.push(courseId);
        } else {
            remaining.push(courseId);
        }
    }

    const status = getStatus(remaining.length === 0, satisfying.length > 0);

    return {
        ruleId: rule.ruleId,
        label: rule.label,
        status,
        coursesSatisfying: satisfying,
        remaining: remaining.length,
        coursesRemaining: remaining,
    };
}

function evaluateChooseN(
    rule: ChooseNRule,
    completedCourses: Set<string>,
    courseCatalog: Map<string, Course>,
    equivalence: EquivalenceResolver
): RuleAuditResult {
    const satisfying: string[] = [];
    const mathSubstitutionsUsed: string[] = [];

    for (const courseId of completedCourses) {
        if (matchesPool(courseId, rule.fromPool, equivalence)) {
            // If minLevel specified, check course level
            if (rule.minLevel) {
                const course = courseCatalog.get(courseId);
                const level = course ? extractCourseLevel(courseId) : extractCourseLevel(equivalence.getCanonical(courseId));
                if (level < rule.minLevel) continue;
            }
            satisfying.push(courseId);
        }
    }

    if (rule.mathSubstitutionPool && rule.maxMathSubstitutions) {
        for (const courseId of rule.mathSubstitutionPool) {
            if (equivalence.isInSet(courseId, completedCourses)) {
                if (mathSubstitutionsUsed.length < rule.maxMathSubstitutions) {
                    satisfying.push(courseId);
                    mathSubstitutionsUsed.push(courseId);
                }
            }
        }
    }

    const needed = Math.max(0, rule.n - satisfying.length);
    const status = getStatus(needed === 0, satisfying.length > 0);

    // For coursesRemaining, list pool courses not yet taken (up to needed)
    // Always include wildcards as hints.
    const availableRemaining = rule.fromPool.filter(
        (pattern) => pattern.includes("*") || !equivalence.isInSet(pattern, completedCourses)
    );

    return {
        ruleId: rule.ruleId,
        label: rule.label,
        status,
        coursesSatisfying: satisfying,
        remaining: needed,
        coursesRemaining: availableRemaining,
    };
}

function evaluateMinCredits(
    rule: MinCreditsRule,
    completedCourses: Set<string>,
    courseCatalog: Map<string, Course>,
    equivalence: EquivalenceResolver
): RuleAuditResult {
    const satisfying: string[] = [];
    let creditsEarned = 0;

    for (const courseId of completedCourses) {
        if (matchesPool(courseId, rule.fromPool, equivalence)) {
            satisfying.push(courseId);
            const course = courseCatalog.get(courseId);
            if (course) {
                creditsEarned += course.credits;
            } else {
                creditsEarned += 4; // Assumed default if missing from catalog
            }
        }
    }

    const creditsRemaining = Math.max(0, rule.minCredits - creditsEarned);
    const status = getStatus(creditsRemaining === 0, creditsEarned > 0);

    return {
        ruleId: rule.ruleId,
        label: rule.label,
        status,
        coursesSatisfying: satisfying,
        remaining: creditsRemaining,
        coursesRemaining: rule.fromPool.filter(
            (id) => !equivalence.isInSet(id, completedCourses)
        ),
    };
}

function evaluateMinLevel(
    rule: MinLevelRule,
    completedCourses: Set<string>,
    courseCatalog: Map<string, Course>,
    equivalence: EquivalenceResolver
): RuleAuditResult {
    const satisfying: string[] = [];

    for (const courseId of completedCourses) {
        if (matchesPool(courseId, rule.fromPool, equivalence)) {
            const level = extractCourseLevel(courseId);
            if (level >= rule.minLevel) {
                satisfying.push(courseId);
            }
        }
    }

    const needed = Math.max(0, rule.minCount - satisfying.length);
    const status = getStatus(needed === 0, satisfying.length > 0);

    return {
        ruleId: rule.ruleId,
        label: rule.label,
        status,
        coursesSatisfying: satisfying,
        remaining: needed,
        coursesRemaining: rule.fromPool.filter(
            (id) => !equivalence.isInSet(id, completedCourses)
        ),
    };
}

// ---- Helpers ----

function getStatus(
    isSatisfied: boolean,
    hasProgress: boolean
): RuleStatus {
    if (isSatisfied) return "satisfied";
    if (hasProgress) return "in_progress";
    return "not_started";
}

/**
 * Extract the numeric level from a course ID.
 * e.g. "CSCI-UA 310" → 300, "MATH-UA 122" → 100
 */
function extractCourseLevel(courseId: string): number {
    const match = courseId.match(/(\d+)$/);
    if (!match) return 0;
    const num = parseInt(match[1], 10);
    return Math.floor(num / 100) * 100;
}
