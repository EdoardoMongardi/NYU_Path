// ============================================================
// NYUPath — Core Data Models
// ============================================================

// ---- Course Catalog ----

export interface Course {
    /** e.g. "CSCI-UA 102" */
    id: string;
    title: string;
    credits: number;
    /** Departments offering this course, e.g. ["CSCI-UA"] */
    departments: string[];
    /** Cross-listed equivalents, e.g. ["DS-UA 201"] */
    crossListed: string[];
    /** Mutually exclusive courses that cannot both count */
    exclusions: string[];
    /** Semesters typically offered */
    termsOffered: ("fall" | "spring" | "summer" | "january")[];
    /** Range of catalog years this course exists in */
    catalogYearsActive: [string, string]; // [start, end]
}

// ---- Prerequisites ----

export interface PrereqGroup {
    type: "AND" | "OR";
    courses: string[]; // course IDs
}

export interface Prerequisite {
    /** The course that has these prerequisites */
    course: string;
    /** Groups of prerequisites (all groups must be satisfied) */
    prereqGroups: PrereqGroup[];
    /** Corequisites — may be taken concurrently */
    coreqs: string[];
}

// ---- Rules ----

export type RuleType = "must_take" | "choose_n" | "min_credits" | "min_level";
export type DoubleCountPolicy = "allow" | "limit_1" | "disallow";

export interface BaseRule {
    ruleId: string;
    /** Human-readable label, e.g. "CS Core Courses" */
    label: string;
    type: RuleType;
    doubleCountPolicy: DoubleCountPolicy;
    catalogYearRange: [string, string]; // [start, end]
    /** Program IDs that auto-satisfy this rule, e.g. ["cs_major_ba"] exempts CS majors from FSI */
    conditionalExemption?: string[];
    /** Student flags that auto-satisfy this rule, e.g. ["nonEnglishSecondary", "eslPathway"] */
    flagExemption?: string[];
    /** Human-readable reason for exemption, e.g. "Exempt for Courant science majors" */
    exemptionLabel?: string;
}

/** Student must take ALL courses in the list */
export interface MustTakeRule extends BaseRule {
    type: "must_take";
    courses: string[];
}

export interface ChooseNRule extends BaseRule {
    type: "choose_n";
    n: number;
    fromPool: string[]; // course IDs or patterns like "CSCI-UA 4*"
    minLevel?: number;
    mathSubstitutionPool?: string[];
    maxMathSubstitutions?: number;
}

/** Student must accumulate at least N credits from a pool */
export interface MinCreditsRule extends BaseRule {
    type: "min_credits";
    minCredits: number;
    fromPool: string[];
}

/** Student must take at least N courses at or above a level */
export interface MinLevelRule extends BaseRule {
    type: "min_level";
    minLevel: number;
    minCount: number;
    fromPool: string[];
}

export type Rule = MustTakeRule | ChooseNRule | MinCreditsRule | MinLevelRule;

// ---- Program (Degree Requirements) ----

export interface Program {
    programId: string;
    /** e.g. "Computer Science BA" */
    name: string;
    catalogYear: string;
    school: string; // e.g. "CAS"
    department: string;
    totalCreditsRequired: number;
    rules: Rule[];
}

// ---- Student Profile ----

export interface CourseTaken {
    courseId: string;
    grade: string;
    semester: string; // e.g. "2023-fall"
    /** Optional explicit credit value for courses not in the master catalog */
    credits?: number;
}

export interface TransferCredit {
    /** Source description, e.g. "AP Computer Science A" or "MIT 6.0001" */
    source: string;
    /** Score or grade, e.g. "5" for AP, "A" for transfer */
    scoreOrGrade: string;
    /** NYU equivalent course ID if it maps to a specific course */
    nyuEquivalent?: string;
    /** Credits awarded */
    credits: number;
}

export interface StudentProfile {
    id: string; // anonymized
    catalogYear: string;
    declaredPrograms: string[]; // program IDs
    coursesTaken: CourseTaken[];
    /** AP/IB/A-Level/transfer credits that map to specific NYU courses */
    transferCourses?: TransferCredit[];
    /** Generic transfer credits that don't map to any specific course */
    genericTransferCredits?: number;
    /** Student-specific flags for conditional exemptions */
    /** e.g. ["nonEnglishSecondary", "eslPathway", "bsBsProgram", "flExemptByExam"] */
    flags?: string[];
    /** Visa status for enrollment rules: "f1" = full-time required, "domestic" = advisory only */
    visaStatus?: "f1" | "domestic" | "other";
    /**
     * Courses the student is currently enrolled in this semester (grades pending).
     * These do NOT satisfy prerequisites yet — they're used for prereq risk analysis.
     */
    currentSemester?: {
        term: string;
        courses: Array<{ courseId: string; title: string; credits: number }>;
    };
}

// ---- Audit Result ----

export type RuleStatus = "satisfied" | "in_progress" | "not_started";

export interface RuleAuditResult {
    ruleId: string;
    label: string;
    status: RuleStatus;
    /** Courses applied toward this rule */
    coursesSatisfying: string[];
    /** Remaining courses needed (for must_take) or count remaining */
    remaining: number;
    /** Specific courses still needed (for must_take rules) */
    coursesRemaining: string[];
    /** If rule was auto-satisfied by exemption, explains why */
    exemptReason?: string;
}

export interface AuditResult {
    studentId: string;
    programId: string;
    programName: string;
    catalogYear: string;
    timestamp: string;
    overallStatus: RuleStatus;
    totalCreditsCompleted: number;
    totalCreditsRequired: number;
    rules: RuleAuditResult[];
    /** Warnings like "course X is cross-listed with Y, counted only once" */
    warnings: string[];
}

// ---- Planner Types (Phase 1) ----

export interface PlannerConfig {
    /** Target semester, e.g. "2025-fall" */
    targetSemester: string;
    /** Maximum courses per semester */
    maxCourses: number;
    /** Maximum credits per semester */
    maxCredits: number;
    /** Minimum credits per semester (default: 12 for F-1 Fall/Spring, 0 otherwise) */
    minCredits?: number;
    /** Student's target graduation semester, e.g. "2027-spring" — enables balanced pacing */
    targetGraduation?: string;
    /** Is this the student's final semester? Relaxes F-1 min-credit rules */
    isFinalSemester?: boolean;
    /** Course IDs the student has marked as online sections */
    onlineCourseIds?: string[];
    /** Optional: courses the student wants to prioritize */
    preferredCourses?: string[];
    /** Optional: courses the student wants to avoid */
    avoidCourses?: string[];
}

export interface CourseSuggestion {
    courseId: string;
    title: string;
    credits: number;
    /** Why this course was recommended */
    reason: string;
    /** Priority score (higher = more important to take now) */
    priority: number;
    /** Number of future courses transitively blocked without this */
    blockedCount: number;
    /** Which unmet rules this course helps satisfy */
    satisfiesRules: string[];
    /** "required" = satisfies unmet major/core rule, "elective" = filler/interest-based */
    category: "required" | "elective";
    /**
     * If this course requires a currently in-progress course as a prerequisite,
     * this lists the in-progress courseIds it depends on.
     * Means the suggestion is CONDITIONAL on the student passing those courses with C or better.
     */
    prereqRisk?: string[];
}

export interface GraduationRisk {
    /** Risk level */
    level: "none" | "low" | "medium" | "high" | "critical";
    /** Human-readable description */
    message: string;
    /** Courses causing the risk */
    courses: string[];
}

export interface SemesterPlan {
    studentId: string;
    targetSemester: string;
    /** Suggested courses, ordered by priority */
    suggestions: CourseSuggestion[];
    /** Graduation risk warnings */
    risks: GraduationRisk[];
    /** Remaining semesters estimate */
    estimatedSemestersLeft: number;
    /** Credits planned this semester */
    plannedCredits: number;
    /** Total credits after this semester */
    projectedTotalCredits: number;
    /** Free elective slots available (for interest-based suggestions) */
    freeSlots: number;
    /** Enrollment validation warnings (F-1 rules, half-time status) */
    enrollmentWarnings: string[];
}
