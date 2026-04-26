// ============================================================
// Zod schemas for SchoolConfig and Program file bodies (Phase 2)
// ============================================================
// Closes the Phase 1 follow-up #4.1: every JSON body that flows through
// the loaders is now Zod-validated. A field-name typo (e.g., "pasFail"
// instead of "passFail") is now caught at load time rather than as
// silent `undefined` reads at audit time.
//
// Schemas use `.passthrough()` so we tolerate the documentation fields
// `_meta`, `_provenance`, `_notes` that live alongside the data body.
// The `_meta` block is validated separately by `schema.ts`.
// ============================================================

import { z } from "zod";

// ---- Reusable atoms ----

const programTypeSchema = z.enum(["major", "minor", "concentration"]);

const residencyTypeSchema = z.enum(["suffix_based", "total_nyu_credits"]);

const careerLimitTypeSchema = z.enum(["credits", "courses", "percent_of_program"]);

const perTermUnitSchema = z.enum(["semester", "academic_year"]);

const creditCapTypeSchema = z.enum([
    "non_home_school",
    "online",
    "transfer",
    "advanced_standing",
    "independent_study",
    "internship",
    "specific_school",
]);

const ruleTypeSchema = z.enum(["must_take", "choose_n", "min_credits", "min_level"]);

const doubleCountPolicySchema = z.enum(["allow", "limit_1", "disallow"]);

// ---- SchoolConfig body schema ----

const residencyConfigSchema = z.object({
    type: residencyTypeSchema,
    suffix: z.string().optional(),
    minCredits: z.number().nullable(),
    finalCreditsInResidence: z.number().nullable().optional(),
    majorMinorResidencyPercent: z.number().optional(),
    note: z.string().optional(),
}).passthrough();

const creditCapSchema = z.object({
    type: creditCapTypeSchema,
    maxCredits: z.number().optional(),
    maxCourses: z.number().optional(),
    maxPerDepartment: z.number().optional(),
    schoolId: z.string().optional(),
    subtype: z.string().optional(),
    label: z.string().optional(),
    excludes: z.array(z.string()).optional(),
    includesInternship: z.boolean().optional(),
    gpaMinimum: z.number().optional(),
    additionalRules: z.array(z.string()).optional(),
}).passthrough();

const passFailConfigSchema = z.object({
    careerLimitType: careerLimitTypeSchema,
    careerLimit: z.number().nullable(),
    careerLimitScope: z.string().optional(),
    perTermLimit: z.number().nullable().optional(),
    perTermUnit: perTermUnitSchema.optional(),
    countsForMajor: z.boolean().optional(),
    countsForMinor: z.boolean().optional(),
    countsForGenEd: z.boolean().optional(),
    creditType: z.string().optional(),
    canElect: z.boolean(),
    autoExcludedFromLimit: z.array(z.string()).optional(),
    excludedCourseTypes: z.array(z.string()).optional(),
    gradePassEquivalent: z.string().optional(),
    failCountsInGpa: z.boolean().optional(),
    exceptions: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    note: z.string().optional(),
}).passthrough();

const spsPolicySchema = z.object({
    allowed: z.boolean(),
    allowedPrefixes: z.array(z.string()).optional(),
    creditType: z.string().optional(),
    countsTowardResidency: z.boolean().optional(),
    countsAgainstNonHomeSchoolCap: z.boolean().optional(),
    excludedCourseTypes: z.array(z.string()).optional(),
}).passthrough();

const doubleCountingConfigSchema = z.object({
    defaultMajorToMajor: z.number().nullable(),
    defaultMajorToMinor: z.number().nullable(),
    defaultMinorToMinor: z.number().nullable().optional(),
    defaultConcentrationToConcentration: z.number().nullable().optional(),
    defaultMajorToConcentration: z.number().nullable().optional(),
    defaultMinorToConcentration: z.number().nullable().optional(),
    noTripleCounting: z.boolean(),
    requiresDepartmentApproval: z.boolean(),
    overrideByProgram: z.union([
        z.boolean(),
        z.record(z.string(), z.object({
            majorToMajor: z.number().optional(),
            majorToMinor: z.number().optional(),
        }).passthrough()),
    ]).optional(),
    exceptions: z.array(z.string()).optional(),
    note: z.string().optional(),
}).passthrough();

const transferCreditLimitsSchema = z.object({
    firstYearMaxTotal: z.number().optional(),
    transferStudentMaxTotal: z.number().optional(),
    springAdmitPostSecondaryMax: z.number().optional(),
}).passthrough();

const gradeThresholdsSchema = z.object({
    core: z.string().optional(),
    major: z.string().optional(),
    minor: z.string().optional(),
    concentration: z.string().optional(),
    nursingPrerequisite: z.string().optional(),
    nonNursing: z.string().optional(),
}).passthrough();

const overloadRequirementSchema = z.object({
    condition: z.string(),
    minGpa: z.number().nullable().optional(),
    minSemesters: z.number().optional(),
    minCreditsCompleted: z.number().optional(),
    maxCredits: z.number().optional(),
    note: z.string().optional(),
}).passthrough();

const deansListThresholdSchema = z.object({
    minGpa: z.number(),
    minCredits: z.number().optional(),
    per: z.enum(["term", "year"]).optional(),
    note: z.string().optional(),
}).passthrough();

const advisingContactSchema = z.object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
}).passthrough();

const lifecycleConfigSchema = z.object({
    type: z.string(),
    expectedTransitionSemesters: z.number().optional(),
    maxSemesters: z.number().optional(),
    transitionTarget: z.string().optional(),
    transitionRequires: z.array(z.string()).optional(),
    warningThreshold: z.number().optional(),
    warningMessage: z.string().optional(),
    dismissalTrigger: z.string().optional(),
    dualAuditMode: z.boolean().optional(),
}).passthrough();

export const schoolConfigBodySchema = z.object({
    schoolId: z.string(),
    name: z.string(),
    degreeType: z.string().nullable(),
    courseSuffix: z.array(z.string()),
    totalCreditsRequired: z.number().nullable(),
    overallGpaMin: z.number(),
    auditMode: z.enum(["full", "advising_only"]).optional(),
    residency: residencyConfigSchema,
    creditCaps: z.array(creditCapSchema).optional(),
    gradeThresholds: gradeThresholdsSchema.optional(),
    passFail: passFailConfigSchema.optional(),
    spsPolicy: spsPolicySchema.optional(),
    doubleCounting: doubleCountingConfigSchema.optional(),
    transferCreditLimits: transferCreditLimitsSchema.optional(),
    acceptsTransferCredit: z.boolean(),
    maxCreditsPerSemester: z.number().optional(),
    overloadRequirements: z.array(overloadRequirementSchema).optional(),
    gpaTierTable: z.array(z.object({
        semestersCompleted: z.number().nullable(),
        minCumGpa: z.number(),
        minCreditsEarned: z.number().optional(),
        note: z.string().optional(),
    }).passthrough()).optional(),
    finalProbationGpaFloor: z.number().optional(),
    goodStandingReturnThreshold: z.number().optional(),
    maxCourseRepeats: z.number().optional(),
    sharedPrograms: z.array(z.string()).optional(),
    timeLimitYears: z.number().nullable().optional(),
    programExclusions: z.array(z.unknown()).optional(),
    deansListThreshold: deansListThresholdSchema.optional(),
    supportedProgramTypes: z.array(programTypeSchema).optional(),
    lifecycle: lifecycleConfigSchema.optional(),
    advisingContact: advisingContactSchema.optional(),
    milestones: z.array(z.unknown()).optional(),
}).passthrough();

// ---- Program body schema ----

const baseRuleSchema = z.object({
    ruleId: z.string(),
    label: z.string(),
    type: ruleTypeSchema,
    doubleCountPolicy: doubleCountPolicySchema,
    catalogYearRange: z.tuple([z.string(), z.string()]),
    conditionalExemption: z.array(z.string()).optional(),
    flagExemption: z.array(z.string()).optional(),
    exemptionLabel: z.string().optional(),
}).passthrough();

const mustTakeRuleSchema = baseRuleSchema.extend({
    type: z.literal("must_take"),
    courses: z.array(z.string()),
});

const chooseNRuleSchema = baseRuleSchema.extend({
    type: z.literal("choose_n"),
    n: z.number(),
    fromPool: z.array(z.string()),
    minLevel: z.number().optional(),
    mathSubstitutionPool: z.array(z.string()).optional(),
    maxMathSubstitutions: z.number().optional(),
});

const minCreditsRuleSchema = baseRuleSchema.extend({
    type: z.literal("min_credits"),
    minCredits: z.number(),
    fromPool: z.array(z.string()),
});

const minLevelRuleSchema = baseRuleSchema.extend({
    type: z.literal("min_level"),
    minLevel: z.number(),
    minCount: z.number(),
    fromPool: z.array(z.string()),
});

const ruleSchema = z.union([
    mustTakeRuleSchema,
    chooseNRuleSchema,
    minCreditsRuleSchema,
    minLevelRuleSchema,
]);

export const programBodySchema = z.object({
    programId: z.string(),
    name: z.string(),
    catalogYear: z.string(),
    school: z.string(),
    department: z.string(),
    totalCreditsRequired: z.number(),
    rules: z.array(ruleSchema),
}).passthrough();

// ---- Validators (mirror provenance/schema.ts shape) ----

export type ValidateBodyResult<T> =
    | { ok: true; body: T }
    | { ok: false; errors: string[] };

export function validateSchoolConfigBody(
    input: unknown,
): ValidateBodyResult<z.infer<typeof schoolConfigBodySchema>> {
    const r = schoolConfigBodySchema.safeParse(input);
    if (r.success) return { ok: true, body: r.data };
    return {
        ok: false,
        errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
}

export function validateProgramBody(
    input: unknown,
): ValidateBodyResult<z.infer<typeof programBodySchema>> {
    const r = programBodySchema.safeParse(input);
    if (r.success) return { ok: true, body: r.data };
    return {
        ok: false,
        errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
}

// ---- Transfer requirements body schema (Phase 2 F2) ----

const transferRequirementCategorySchema = z.object({
    category: z.string(),
    description: z.string(),
    satisfiedBy: z.array(z.string()),
}).passthrough();

const transferEntryYearRequirementsSchema = z.object({
    entryYear: z.enum(["sophomore", "junior"]),
    requiredCourseCategories: z.array(transferRequirementCategorySchema),
}).passthrough();

export const transferRequirementsBodySchema = z.object({
    fromSchool: z.string(),
    toSchool: z.string(),
    applicationDeadline: z.string(),
    acceptedTerms: z.array(z.string()),
    minCreditsCompleted: z.number(),
    disqualifiers: z.array(z.string()).optional(),
    disqualifierReasons: z.record(z.string(), z.string()).optional(),
    entryYearRequirements: z.array(transferEntryYearRequirementsSchema),
    equivalencyUrl: z.string().optional(),
    applicationUrl: z.string().optional(),
    notes: z.array(z.string()).optional(),
}).passthrough();

export const nyuInternalTransferPolicyBodySchema = z.object({
    policyKind: z.literal("nyu_wide_floor"),
    earliestApplicationTerm: z.string(),
    latestApplicationTerm: z.string(),
    duplicateMajorRule: z.string(),
    notes: z.array(z.string()),
}).passthrough();

export function validateTransferRequirementsBody(
    input: unknown,
): ValidateBodyResult<z.infer<typeof transferRequirementsBodySchema>> {
    const r = transferRequirementsBodySchema.safeParse(input);
    if (r.success) return { ok: true, body: r.data };
    return {
        ok: false,
        errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
}

export function validateNyuTransferPolicyBody(
    input: unknown,
): ValidateBodyResult<z.infer<typeof nyuInternalTransferPolicyBodySchema>> {
    const r = nyuInternalTransferPolicyBodySchema.safeParse(input);
    if (r.success) return { ok: true, body: r.data };
    return {
        ok: false,
        errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
}
