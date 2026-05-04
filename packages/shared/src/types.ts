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

/**
 * A single prerequisite constraint group on a course.
 *
 * The semantics:
 *   - "AND" → every entry in `courses` must be satisfied.
 *   - "OR"  → at least one entry in `courses` must be satisfied.
 *   - "NOT" → none of the entries in `notCourses` may have been taken
 *             (Phase 13 enforces; e.g. "Not open to students who have
 *             completed CSCI-UA 0002"). For a "NOT" group, `courses`
 *             is empty and `notCourses` carries the excluded list.
 *
 * Optional fields:
 *   - `requiresPetition` — true when the bulletin English mentions
 *     "or instructor permission" / "or department approval". The
 *     solver soft-allows the course (placement is permitted) but the
 *     UI surfaces a yellow flag so the student knows a real-world
 *     petition step is needed. Set on the group whose OR clause
 *     contained the permission language.
 *   - `notCourses` — populated only when type === "NOT". Listed
 *     separately from `courses` because the polarity differs (NOT
 *     excludes; AND/OR include).
 *
 * Note on coreqs: corequisites live at the `Prerequisite` entry
 * level, not inside this group. A coreq applies to the whole
 * dependent course, not to one particular constraint group.
 */
export interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses: string[]; // course IDs (empty for "NOT" groups)
    requiresPetition?: boolean;
    notCourses?: string[];
}

export interface Prerequisite {
    /** The course that has these prerequisites */
    course: string;
    /** Groups of prerequisites (all groups must be satisfied) */
    prereqGroups: PrereqGroup[];
    /** Corequisites — may be taken concurrently */
    coreqs: string[];
    /**
     * Optional grade-threshold map: courseId → required minimum grade
     * (e.g. "C", "B+", "D"). When the prereq solver checks whether a student
     * has satisfied a prereq via a particular course, it must ALSO verify
     * the student's grade for that course meets the threshold here. If a
     * course in `prereqGroups[].courses[]` is NOT in this map, no grade
     * threshold applies — only "passed" matters.
     *
     * Source: bulletin's "with a Minimum Grade of X" annotations,
     * extracted by tools/bulletin-parser/extractGradeThresholds.ts.
     * Reverses Decision #4 ("trust DPR") in favor of explicit threshold
     * checking — the silent-bug risk on rare high-grade prereqs (B/B+/A-)
     * outweighs the simplicity argument.
     */
    minGrades?: Record<string, string>;
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
    /** Phase 7-A P-2: course IDs (or patterns) the rule explicitly
     *  EXCLUDES from the pool, even when they would otherwise match
     *  a wildcard. Used by e.g. cas_philosophy_ba's elective rule
     *  which says "two additional PHIL-UA courses, except introductory
     *  courses (numbered 1 through 8)". */
    excludeFromPool?: string[];
    minLevel?: number;
    mathSubstitutionPool?: string[];
    maxMathSubstitutions?: number;
}

/** Student must accumulate at least N credits from a pool */
export interface MinCreditsRule extends BaseRule {
    type: "min_credits";
    minCredits: number;
    fromPool: string[];
    /** P7-A P-2: pool exclusions (see ChooseNRule.excludeFromPool). */
    excludeFromPool?: string[];
}

/** Student must take at least N courses at or above a level */
export interface MinLevelRule extends BaseRule {
    type: "min_level";
    minLevel: number;
    minCount: number;
    fromPool: string[];
    /** P7-A P-2: pool exclusions. */
    excludeFromPool?: string[];
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

/**
 * One row in a per-semester minimum-cumulative-GPA table. Used by schools
 * that publish a tiered floor (e.g., Tandon — see Tandon bulletin L287-300).
 *
 * Semantic: a student is in good standing as long as
 *   semestersCompleted >= row.semestersCompleted ⇒ cumulativeGPA >= row.minCumGpa
 * for the LARGEST row whose `semestersCompleted` <= the student's count.
 *
 * `semestersCompleted: null` represents the open-ended ">N" tier (e.g.,
 * Tandon's ">8" row). At most one row should carry `null`; it acts as the
 * floor for any student beyond the highest finite tier.
 */
export interface GpaTierRow {
    semestersCompleted: number | null;
    minCumGpa: number;
    minCreditsEarned?: number;
    note?: string;
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
    /**
     * F-1 visa-status full-time minimum credits per semester. Sourced
     * from NYU OGS guidance + the school's own bulletin restatement.
     * The historic 12-credit floor lives here as data so it can vary
     * per school (e.g., a graduate school's full-time minimum differs).
     * Phase 10 Stage 2 — moved out of getCreditCaps.ts magic constant.
     */
    f1FullTimeMinCredits?: number;
    overloadRequirements?: OverloadRequirement[];
    /**
     * Per-semester minimum-cumulative-GPA tiers. When present, supersedes
     * `overallGpaMin` for academic-standing checks: the engine looks up
     * the active tier for the student's `semestersCompleted` and uses that
     * tier's `minCumGpa` instead of the flat `overallGpaMin`.
     * Source: schools that publish a tiered floor — e.g., Tandon §
     * "Minimum Credits and Minimum GPA Required by Semester of Full-Time
     * Study" (engineering academic-policies bulletin L287-300).
     */
    gpaTierTable?: GpaTierRow[];
    /**
     * Cumulative-GPA floor below which the student is placed on a special
     * Final-Probation track regardless of credit count. Source: Tandon
     * bulletin L303 footnote: "Any time a student's cumulative GPA falls
     * below 1.5 they are placed on Final Probation regardless of how many
     * credits they have completed."
     */
    finalProbationGpaFloor?: number;
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

// === Phase 12.9.5 — Offering Confidence ===

/**
 * Phase 12.9.5 — confidence tier for a course's term-offering pattern.
 *
 * Used by Phase 13's solver to penalize scheduling low-confidence courses
 * into critical-path slots, and by the agent to honestly surface
 * scheduling risk to students. Phase 15's FOSE materializer promotes
 * courses to `confirmed` when their actual section lands in FOSE.
 */
export type ConfidenceTier =
    | "historically_likely"
    | "historically_partial"
    | "irregular"
    | "permission_only"
    | "restricted"
    | "confirmed";

/**
 * One entry in `packages/engine/src/data/courses-offerings.json`.
 *
 * Formally defined here in Phase 12.9.5; previously existed only as an
 * inline interface in packages/engine/tests/data/parsedDataValidation.test.ts.
 * That inline definition is left in place (duplicate-but-harmless) until a
 * future cleanup task imports from shared instead.
 */
export interface OfferingEntry {
    termsOffered: ("fall" | "spring" | "summer" | "january")[];
    rawLine: string;
    inferred: boolean;
    /** Phase 12.9.5: classified confidence in this offering pattern. */
    confidence?: ConfidenceTier;
}

// === Phase 13 — Forward Planner ===

// ---- 1. ValidationResult + DataSource + ApprovalAuthority (Decision #40) ----

export type DataSource = "DPR" | "FOSE" | "bulletin" | "program-rules" | "student-input";
export type ApprovalAuthority = "instructor" | "department" | "advisor" | "registrar" | "OGS" | "school-dean";

export type ValidationResult =
    | { status: "pass"; verifiedFrom: DataSource }
    | { status: "assumed-pass"; assumption: string; whatWouldFlipIt: string }
    | { status: "requires-approval"; authority: ApprovalAuthority }
    | { status: "fail"; reason: string };

// ---- 2. WorkloadTier (Decision #24) + LoadRationale (Decisions #22d + #24) + Assumption (Decisions #30 + #42) ----

export type WorkloadTier =
    | "major-required"
    | "major-elective"
    | "school-core"
    | "free-elective"
    | "general-elective";

export interface LoadRationale {
    strategy: "balanced" | "frontload" | "backload" | "light" | "heavy";
    creditsTarget: number;
    slack: number;
    weightedCredits: number;       // Σ slot.credits × slot.workloadWeight
    hardCount: number;             // slots with workloadWeight ≥ 1.0
    easyCount: number;             // slots with workloadWeight < 1.0
    alternativeDistributionsConsidered: Array<{
        distribution: number[];
        rejectedBecause: string;
    }>;
}

/**
 * Discriminated union per Decisions #30 + #42. Three variants:
 *  - IP_COURSE_COMPLETION  (#30; solver-emitted)
 *  - LLM_RANKED_ALTERNATIVE (#42 Tier B; Phase-14-emitted)
 *  - HEURISTIC_MAPPING      (#42 Tier D; Phase-14-emitted; SOFT ONLY —
 *                            the `studentConstraintFraming: "soft"`
 *                            literal type is the Layer-2 schema
 *                            discriminator in the 3-layer Tier-D
 *                            enforcement. A "hard" framing is a
 *                            TypeScript compile-time error.)
 */
export type Assumption =
    | {
          type: "IP_COURSE_COMPLETION";
          courseId: string;
          requiredGrade?: string;
          consequenceIfFalse: string;
          cascadingSlots: string[];
          contingencyPlanAvailable: boolean;
      }
    | {
          type: "LLM_RANKED_ALTERNATIVE";
          studentStatedFactor: string;
          selectedPlanIndex: number;
          reasoning: string;
          dimensionsConsidered: string[];
      }
    | {
          type: "HEURISTIC_MAPPING";
          studentStatedFactor: string;
          /** Layer-2 of Tier-D 3-layer enforcement. Literal "soft" —
           *  hard-framed constraints CANNOT construct this variant. */
          studentConstraintFraming: "soft";
          /** Phase 14 will tighten this to PlanMutation once that type is defined
           *  (Phase 14 Task 1). Typed as unknown for now per controller note 5. */
          mappedToMutation: unknown;
          confidence: "low" | "medium" | "high";
          reasoning: string;
          consequenceIfWrong: string;
      };

// ---- 3. ConfidenceTier is already defined at line 648 (Phase 12.9.5) — no redefinition needed ----

// ---- 4. PoolBinding (Decision #28) + PlaceholderSlot tagged union (Decision #38) ----

export interface PoolBinding {
    poolId: string;
    candidates: string[];   // courseIds
    satisfiesRule: string;  // ruleId
}

export interface RequirementPoolSlot {
    kind: "requirement-pool";
    ruleId: string;
    candidates: string[];               // courseIds
    constraints: Array<{ kind: string; detail: string }>;
    bindingState: "unbound" | "candidate-set" | "bound";
    bound?: string;                     // courseId
}

export interface FreeCreditSlot {
    kind: "free-credit";
    defaultWeight: 0.3;                 // per Decision #37
    bindingState: "placeholder-pending" | "placeholder-deferred" | "bound";
    bound?: string;                     // courseId
}

export interface AdvisingPlaceholderSlot {
    kind: "advising-placeholder";
    advisingNote: string;
    bindingState: "advisor-pending" | "bound";
    bound?: string;                     // courseId
}

/** Tagged union per Decision #38. The `kind` discriminator enables
 *  exhaustiveness checks across Phase 14's binding tools. */
export type PlaceholderSlot =
    | RequirementPoolSlot
    | FreeCreditSlot
    | AdvisingPlaceholderSlot;

// ---- 5. SlotRationale + TermConstraint (Decision #22a) ----

export type TermConstraintKind =
    | "prereqChain"
    | "offering"
    | "creditCeiling"
    | "creditFloor"
    | "visaFloor"
    | "coreqSameTerm";

export interface TermConstraint {
    kind: TermConstraintKind;
    detail: string;
}

export interface SlotRationale {
    satisfiesRequirements: string[];     // ruleIds
    termConstraints: TermConstraint[];
    consideredAlternatives: Array<{
        courseId: string;
        rejectedBecause: string;
    }>;
    decisionsApplied: string[];          // e.g. "D4-IPProjection"
    petitionTrigger?: { fromCourse: string; bulletinText: string };
}

export interface SlotFlexibility {
    earliestPossibleTerm: string;        // term code
    latestPossibleTerm: string;
    alternativeCourses: string[];        // courseIds
}

export interface DownstreamImpact {
    courseIds: string[];
    graduationDelay: number;             // terms
}

// ---- 6. ScheduleSlot discriminated union (4 kinds) ----

export type ScheduleSlotKind = "completed" | "in_progress" | "specific_planned" | "placeholder";

export interface ScheduleSlotCompleted {
    kind: "completed";
    courseId: string;
    title: string;
    credits: number;
    grade: string;
}

export interface ScheduleSlotInProgress {
    kind: "in_progress";
    courseId: string;
    title: string;
    credits: number;
}

/** specific_planned slot — carries full rationale per Decisions #22a-d, #24, #33, #37, #39, #40 */
export interface ScheduleSlotSpecificPlanned {
    kind: "specific_planned";
    courseId: string;
    title: string;
    credits: number;
    satisfiesRules: string[];
    reason: string;
    requiresPetition?: boolean;
    // Decisions #22a-d, #24, #33, #37, #39, #40 fields:
    rationale: SlotRationale;
    flexibility: SlotFlexibility;
    downstreamImpact: DownstreamImpact;
    workloadTier: WorkloadTier;
    workloadWeight: number;              // 0.3..~1.6 per #24 + #35
    bindingState: "bound";               // specific_planned is always bound
    confidence: ConfidenceTier;          // copied from OfferingEntry per #39
    isCriticalPath: boolean;             // per #39
    optionalReason?: {
        droppable: boolean;
        blockingConstraints?: string[];
    };
    approvalAuthority?: ApprovalAuthority;
}

/** placeholder slot — reserved credits with rich rationale, pending course binding */
export interface ScheduleSlotPlaceholder {
    kind: "placeholder";
    category: string;                    // human-readable label
    credits: number;
    satisfiesRules: string[];
    optional: boolean;                   // per Decision #8
    reason: string;
    // Phase 13 placeholder slots also carry the same rich fields,
    // computed against the placeholder's reserved credits + tier:
    rationale: SlotRationale;
    flexibility: SlotFlexibility;
    downstreamImpact: DownstreamImpact;
    workloadTier: WorkloadTier;
    workloadWeight: number;
    bindingState: "placeholder-pending" | "placeholder-deferred";
    placeholderId: string;
    poolBinding?: PoolBinding;           // present for RequirementPoolSlot kind (#28)
    optionalReason?: {
        droppable: boolean;
        blockingConstraints?: string[];
    };
    confidence: ConfidenceTier;
    isCriticalPath: boolean;
    approvalAuthority?: ApprovalAuthority;
}

export type ScheduleSlot =
    | ScheduleSlotCompleted
    | ScheduleSlotInProgress
    | ScheduleSlotSpecificPlanned
    | ScheduleSlotPlaceholder;

// ---- 7. ForwardSemester (Decision #24 extended) ----

export interface ForwardSemester {
    term: string;                        // e.g. "2026-fall"
    locked: boolean;                     // DPR-derived (completed/in-progress)
    slots: ScheduleSlot[];
    plannedCredits: number;
    notes: string[];                     // visa/load advisories
    loadRationale: LoadRationale;
}

// ---- 8. PlanState 4-state union (Decision #32) ----

export type PlanState =
    | "valid-clean"
    | "valid-with-trade-offs"
    | "infeasible-draft"
    | "student-preferred-invalid-draft";

// ---- 9.1. AlternativePlanSummary (Decision #44) ----

/** Top-K alternative-plan summary from Stage 7. ≤5 per ForwardSchedule. */
export interface AlternativePlanSummary {
    planIndex: number;
    balanceScore: number;
    weightedCreditsByTerm: Record<string, number>;
    hardCountByTerm: Record<string, number>;
    easyCountByTerm: Record<string, number>;
    subjectDistributionByTerm: Record<string, Record<string, number>>;
    distinctSubjectsCount: number;
    totalPetitionCount: number;
    totalAssumptionCount: number;
    graduationTerm: string;
    topDiffsFromWinner: Array<{ aspect: string; change: string }>;
}

// ---- 10. FeasibilityReport + InfeasibilityReport (Decisions #10 / #31) ----

export interface FeasibilityReport {
    feasible: boolean;
    infeasibilityReason?: string;
    constraintViolations: Array<{
        kind:
            | "prereq_unsatisfiable"
            | "offering_pattern"
            | "credit_floor"
            | "credit_ceiling"
            | "graduation_total"
            | "not_clause"
            | "pass_fail_cap"
            | "online_credit_cap"
            | "outside_home_credit_cap"
            | "gpa_floor"
            | "other";
        course?: string;
        term?: string;
        detail: string;
    }>;
    placementRationale: Record<string, string>;
}

export interface InfeasibilityReport {
    conflictSource: "pin" | "exclusion" | "loadStyleOverride" | "schedulingPreference" | "other";
    conflictDetail: string;
    relaxationSuggestions: string[];
    /** Decision #10 — the no-pin (or no-mutation) plan the solver would
     *  have produced absent the conflicting input, so the agent can
     *  surface "here's what works without your pin" cleanly. */
    fallbackSchedule?: ForwardSchedule;
}

// ---- 9. ForwardSchedule (Decisions #25, #30, #32, #44) ----

export interface ForwardSchedule {
    studentId: string;
    homeSchoolId: string;
    graduationTerm: string;
    creditTargetPerSemester: number;
    f1Floor: number | null;
    domesticPartTimeFloor: number | null;
    graduationCreditMinimum: number;
    degreeCreditsMet: boolean;
    semesters: ForwardSemester[];
    dprCourseHistoryHash: string;
    computedAt: number;
    feasibility: FeasibilityReport;
    state: PlanState;                    // Decision #32
    balanceScore: number;                // Decision #25
    assumptions: Assumption[];           // Decision #30 (discriminated union per #42)
    /** Decision #44 — top-K alternative-plan summaries from Stage 7. ≤5. */
    alternativeCandidates?: AlternativePlanSummary[];
}
