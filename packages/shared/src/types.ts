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

// ---- Program Declaration (Phase 1 §11.2) ----
//
// A student declares zero or more programs (majors, minors, concentrations).
// Replaces the legacy `declaredPrograms: string[]` shape so the engine can
// reason about program kind for cross-program audits and double-count rules.

export type ProgramType = "major" | "minor" | "concentration";

export interface ProgramDeclaration {
    /** Program identifier matching a Program.programId, e.g. "cs_major_ba" */
    programId: string;
    /** Kind of declaration — major, minor, or concentration (Stern) */
    programType: ProgramType;
    /** When the student declared this program (free-form, e.g. "2024-fall") */
    declaredAt?: string;
    /** Catalog year the student declared this program under */
    declaredUnderCatalogYear?: string;
}

// ---- School Config (Phase 1 §11.2) ----
//
// One config per NYU school. Generic engine modules read these instead of
// hardcoding CAS/CS values. Optional fields cover the variation across
// schools (e.g., Tandon has no creditCaps[], Gallatin uses advising_only).

export type ResidencyType = "suffix_based" | "total_nyu_credits";

export interface ResidencyConfig {
    type: ResidencyType;
    /** Course-id suffix that counts toward residency, e.g. "-UA" for CAS */
    suffix?: string;
    /** Minimum residency credits — null when school has no fixed limit */
    minCredits: number | null;
    /** Final-N-credits-in-residence rule (e.g., last 32 credits at NYU) */
    finalCreditsInResidence?: number | null;
    /** Percentage of major/minor that must be in residence */
    majorMinorResidencyPercent?: number;
    note?: string;
}

export type CreditCapType =
    | "non_home_school"
    | "online"
    | "transfer"
    | "advanced_standing"
    | "independent_study"
    | "internship"
    | "specific_school";

export interface CreditCap {
    type: CreditCapType;
    /** Credit ceiling */
    maxCredits?: number;
    /** Course-count ceiling (alternative to credits) */
    maxCourses?: number;
    /** Per-department sub-cap (e.g., independent study max 8/dept) */
    maxPerDepartment?: number;
    /** For "specific_school" caps — the school being capped */
    schoolId?: string;
    /** Sub-classification, e.g., "transfer_back" for Stern non_home_school */
    subtype?: string;
    /** Human-readable label */
    label?: string;
    /** Categories excluded from this cap */
    excludes?: string[];
    /** Whether internship credits also count against this cap */
    includesInternship?: boolean;
    /** Minimum GPA gate (e.g., Tandon internship requires 2.5) */
    gpaMinimum?: number;
    /** Free-form additional rule descriptors */
    additionalRules?: string[];
}

export type CareerLimitType = "credits" | "courses" | "percent_of_program";
export type PerTermUnit = "semester" | "academic_year";

export interface PassFailConfig {
    /** Whether the career limit is denominated in credits, courses, or % */
    careerLimitType: CareerLimitType;
    /** Career limit value — null when school has no explicit limit */
    careerLimit: number | null;
    /** For percent-of-program, whether scope is total, plan, or both */
    careerLimitScope?: string;
    /** Per-term limit — null when school has no explicit limit */
    perTermLimit?: number | null;
    /** Whether perTermLimit applies per semester or per academic year */
    perTermUnit?: PerTermUnit;
    /** Whether P/F courses count toward the major */
    countsForMajor?: boolean;
    /** Whether P/F courses count toward minors */
    countsForMinor?: boolean;
    /** Whether P/F courses count toward general education / Core */
    countsForGenEd?: boolean;
    /** Restriction on what P credit may count for, e.g. "elective_only" */
    creditType?: string;
    /** Whether students may elect P/F at all (Tandon: false) */
    canElect: boolean;
    /** Course categories auto-excluded from the P/F limit */
    autoExcludedFromLimit?: string[];
    /** Course categories blocked from P/F (e.g., nursing prereqs) */
    excludedCourseTypes?: string[];
    /** Letter-grade equivalent of "P", e.g. "D" */
    gradePassEquivalent?: string;
    /** Whether F under P/F is computed in GPA */
    failCountsInGpa?: boolean;
    /** Free-form exception strings */
    exceptions?: string[];
    /** Free-form warning strings displayed to students */
    warnings?: string[];
    note?: string;
}

export interface SpsPolicy {
    /** Master switch — false = total ban (Stern, Tandon) */
    allowed: boolean;
    /** Course-id prefixes that may be taken when allowed=true */
    allowedPrefixes?: string[];
    /** What SPS credit may count for, e.g. "elective_only" */
    creditType?: string;
    /** Whether SPS credit counts toward residency */
    countsTowardResidency?: boolean;
    /** Whether SPS credit counts against the non-home-school cap */
    countsAgainstNonHomeSchoolCap?: boolean;
    /** Categories that are excluded even when SPS is generally allowed */
    excludedCourseTypes?: string[];
}

export interface DoubleCountingConfig {
    /** Default max courses double-counted between two majors */
    defaultMajorToMajor: number | null;
    /** Default max courses double-counted between major and minor */
    defaultMajorToMinor: number | null;
    /** Default max courses double-counted between two minors */
    defaultMinorToMinor?: number | null;
    /** Default max courses double-counted between two concentrations */
    defaultConcentrationToConcentration?: number | null;
    /** Default max courses double-counted between a major and a concentration */
    defaultMajorToConcentration?: number | null;
    /** Default max courses double-counted between a minor and a concentration */
    defaultMinorToConcentration?: number | null;
    /** Whether triple-counting is forbidden across all programs */
    noTripleCounting: boolean;
    /** Whether department approval is required for double-counting */
    requiresDepartmentApproval: boolean;
    /**
     * Per-program overrides. May be `true` (overrides allowed program-by-program)
     * or a map of programId → per-pair override values.
     */
    overrideByProgram?:
        | boolean
        | Record<string, { majorToMajor?: number; majorToMinor?: number }>;
    exceptions?: string[];
    note?: string;
}

export interface TransferCreditLimits {
    firstYearMaxTotal?: number;
    transferStudentMaxTotal?: number;
    /** Spring-admit students' post-secondary cap (CAS-specific) */
    springAdmitPostSecondaryMax?: number;
}

export interface GradeThresholds {
    /** Minimum letter grade for Core / general-education courses */
    core?: string;
    /** Minimum letter grade for major courses */
    major?: string;
    /** Minimum letter grade for minor courses */
    minor?: string;
    /** Minimum letter grade for concentration courses (Stern) */
    concentration?: string;
    /** Nursing-prerequisite-specific minimum (Meyers) */
    nursingPrerequisite?: string;
    /** Non-nursing course minimum (Meyers) */
    nonNursing?: string;
}

export interface OverloadRequirement {
    /** "default", "firstYear", "continuing", "probation", etc. */
    condition: string;
    minGpa?: number | null;
    /** Minimum semesters completed before this rule applies */
    minSemesters?: number;
    /** Minimum credits completed before this rule applies */
    minCreditsCompleted?: number;
    /** Hard credit ceiling under this condition */
    maxCredits?: number;
    note?: string;
}

export interface DeansListThreshold {
    minGpa: number;
    minCredits?: number;
    per?: "term" | "year";
    note?: string;
}

export interface AdvisingContact {
    name: string;
    email?: string;
    url?: string;
}

export interface LifecycleConfig {
    /** "forced_exit" for Liberal Studies; future kinds for other lifecycles */
    type: string;
    expectedTransitionSemesters?: number;
    maxSemesters?: number;
    transitionTarget?: string;
    transitionRequires?: string[];
    warningThreshold?: number;
    warningMessage?: string;
    dismissalTrigger?: string;
    /** Whether the engine should run a dual-audit against the target school */
    dualAuditMode?: boolean;
}

export interface SchoolConfig {
    /** Stable identifier, e.g. "cas", "stern", "tandon" */
    schoolId: string;
    name: string;
    /** Primary degree type, e.g. "BA", "BS", or null for advising-only schools */
    degreeType: string | null;
    /** Course-id suffixes belonging to this school, e.g. ["-UA"] */
    courseSuffix: string[];
    /** Degree credit total — null when not fixed (e.g., Liberal Studies) */
    totalCreditsRequired: number | null;
    overallGpaMin: number;
    /** "advising_only" disables hard rule enforcement (Gallatin) */
    auditMode?: "full" | "advising_only";
    residency: ResidencyConfig;
    creditCaps?: CreditCap[];
    gradeThresholds?: GradeThresholds;
    passFail?: PassFailConfig;
    spsPolicy?: SpsPolicy;
    doubleCounting?: DoubleCountingConfig;
    transferCreditLimits?: TransferCreditLimits;
    /** Whether this school accepts inbound transfer credit */
    acceptsTransferCredit: boolean;
    maxCreditsPerSemester?: number;
    overloadRequirements?: OverloadRequirement[];
    /**
     * Completion-rate floor required to *return* to good academic standing
     * after a notice of academic concern. Distinct from federal SAP (which
     * is a financial-aid metric, typically 0.67). For CAS this is 0.75
     * per the bulletin: "complete 75% of attempted credits."
     */
    goodStandingReturnThreshold?: number;
    maxCourseRepeats?: number;
    /** School-level shared programs (e.g., CAS Core) */
    sharedPrograms?: string[];
    timeLimitYears?: number | null;
    programExclusions?: unknown[];
    deansListThreshold?: DeansListThreshold;
    /** Program kinds this school supports (e.g., Stern adds "concentration") */
    supportedProgramTypes?: ProgramType[];
    lifecycle?: LifecycleConfig;
    advisingContact?: AdvisingContact;
    milestones?: unknown[];
}

// ---- Student Profile ----

export interface CourseTaken {
    courseId: string;
    grade: string;
    semester: string; // e.g. "2023-fall"
    /** Optional explicit credit value for courses not in the master catalog */
    credits?: number;
    /** Whether this course was taken online [GEN-ACAD] §A3.3 */
    isOnline?: boolean;
    /** Grade mode: letter (default) or pass/fail [GEN-ACAD] §A3.5 */
    gradeMode?: "letter" | "pf";
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
    /**
     * Phase 1 §11.2: REQUIRED — the student's home school identifier
     * (e.g. "cas", "stern", "tandon"). Drives SchoolConfig lookup.
     */
    homeSchool: string;
    /**
     * Phase 1 §11.2: structured program declarations replacing the legacy
     * `string[]` shape. Each entry carries programType so cross-program
     * audits can distinguish majors vs minors vs concentrations.
     */
    declaredPrograms: ProgramDeclaration[];
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
    /** Total UA-suffix (CAS) credits completed [GEN-ACAD] §A3.2 — for 64-credit residency check */
    uaSuffixCredits?: number;
    /** Credits from non-CAS NYU schools [GEN-ACAD] §A3.3 — max 16 allowed */
    nonCASNYUCredits?: number;
    /** Total online credits taken [GEN-ACAD] §A3.3 — max 24 allowed */
    onlineCredits?: number;
    /** Total P/F credits taken career-wide [GEN-ACAD] §A3.5 — max 32 allowed */
    passfailCredits?: number;
    /** Year of matriculation [GEN-ACAD] §A3.9 — for 8-year time limit check */
    matriculationYear?: number;
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
