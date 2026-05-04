import type { ValidationResult, StudentProfile } from "@nyupath/shared";

/**
 * Phase 13 — Multi-axis F-1 / domestic visa validation per Decisions
 * #34 + #40. Every axis returns a `ValidationResult` from the 4-state
 * union (`pass | assumed-pass | requires-approval | fail`).
 *
 * Phase 13 ships:
 *   - VERIFIED `pass` / `fail` for: `fullTimeSatisfied`,
 *     `creditMinimumSatisfied` (we have credit data).
 *   - `requires-approval` for: `rclEligible`, `cptConflict`,
 *     `finalTermExceptionPossible` (need OGS / registrar action).
 *   - `assumed-pass` PRE-PHASE-15 for: `onlineLimitSatisfied`,
 *     `inPersonMinimumSatisfied` (need FOSE meetingPattern; promoted
 *     to verified `pass`/`fail` once Phase 15's section materializer
 *     supplies the data).
 *
 * Citations are pointers to OGS policy sections so the agent can
 * surface "per OGS Policy 5.2.1 [link]…" Visa errors are
 * high-stakes; the `assumed-pass` distinction prevents the system
 * from claiming verification it didn't perform.
 */
export interface VisaValidationResult {
    fullTimeSatisfied: ValidationResult;
    creditMinimumSatisfied: ValidationResult;
    onlineLimitSatisfied: ValidationResult;
    inPersonMinimumSatisfied: ValidationResult;
    rclEligible: ValidationResult;
    cptConflict: ValidationResult;
    finalTermExceptionPossible: ValidationResult;
    overallWarningLevel: "none" | "low" | "medium" | "high";
    citations: string[];
}

export interface VisaInputContext {
    /** Per-term credit count under evaluation. */
    termCredits: number;
    /** Term code, e.g. "2026-fall". */
    term: string;
    /** Profile shape (we only consume the fields below). */
    profile: Pick<StudentProfile, "visaStatus"> & {
        /** Has the student been approved for an RCL this term? */
        rclApproved?: boolean;
        /** Is the student enrolled in CPT this term? */
        cptEnrolled?: boolean;
        /** Has the student opted into the F-1 final-term exception? */
        finalTermException?: boolean;
        /** Is THIS term the student's final term before graduation? */
        isFinalTerm?: boolean;
        /** Domestic students may explicitly opt below the F-1 floor. */
        allowBelowF1Floor?: boolean;
    };
    /** F-1 floor (typically 12) when the school sets one, else null. */
    f1Floor: number | null;
    /** Domestic part-time floor (typically 8), else null. */
    domesticPartTimeFloor: number | null;
    /** F-1 online-credit cap per term (typically 3). Null when unset. */
    f1OnlineCreditsPerTermCap: number | null;
}

// ---- Axis helpers ----

function evalFullTimeSatisfied(ctx: VisaInputContext): ValidationResult {
    const { termCredits, profile, f1Floor } = ctx;
    const floor = f1Floor ?? 12;
    const isF1 = profile.visaStatus === "f1";

    if (isF1) {
        if (termCredits >= floor) {
            return { status: "pass", verifiedFrom: "DPR" };
        }
        if (profile.rclApproved === true) {
            return { status: "pass", verifiedFrom: "student-input" };
        }
        return {
            status: "fail",
            reason: `F-1 student at ${termCredits} credits below ${floor}-credit full-time floor without RCL approval.`,
        };
    }

    // Domestic (or other)
    if (termCredits >= floor) {
        return { status: "pass", verifiedFrom: "DPR" };
    }
    if (profile.allowBelowF1Floor === true) {
        return { status: "pass", verifiedFrom: "student-input" };
    }
    return {
        status: "fail",
        reason: `Domestic student below ${floor}-credit full-time threshold without explicit allowBelowF1Floor opt-in.`,
    };
}

function evalCreditMinimumSatisfied(ctx: VisaInputContext): ValidationResult {
    const { termCredits, f1Floor, domesticPartTimeFloor } = ctx;
    const floor = domesticPartTimeFloor ?? f1Floor ?? 8;

    if (termCredits >= floor) {
        return { status: "pass", verifiedFrom: "DPR" };
    }
    return {
        status: "fail",
        reason: `Below ${floor}-credit minimum enrollment — student would not be registered for standing.`,
    };
}

function evalOnlineLimitSatisfied(ctx: VisaInputContext): ValidationResult {
    const cap = ctx.f1OnlineCreditsPerTermCap ?? 3;
    return {
        status: "assumed-pass",
        assumption: "all sections in-person",
        whatWouldFlipIt: `if any section is online and total online credits would exceed ${cap} (F-1 limit)`,
    };
}

function evalInPersonMinimumSatisfied(_ctx: VisaInputContext): ValidationResult {
    return {
        status: "assumed-pass",
        assumption: "all sections in-person",
        whatWouldFlipIt: "if any section is online, F-1 in-person minimum may be unmet",
    };
}

function evalRclEligible(ctx: VisaInputContext): ValidationResult {
    const { termCredits, profile, f1Floor } = ctx;
    const floor = f1Floor ?? 12;
    const isF1 = profile.visaStatus === "f1";

    if (!isF1) {
        return { status: "pass", verifiedFrom: "DPR" };
    }
    if (termCredits >= floor) {
        return { status: "pass", verifiedFrom: "DPR" };
    }
    if (profile.rclApproved === true) {
        return { status: "pass", verifiedFrom: "student-input" };
    }
    return { status: "requires-approval", authority: "OGS" };
}

function evalCptConflict(ctx: VisaInputContext): ValidationResult {
    const { profile } = ctx;
    if (profile.visaStatus === "f1" && profile.cptEnrolled === true) {
        return { status: "requires-approval", authority: "OGS" };
    }
    return { status: "pass", verifiedFrom: "DPR" };
}

function evalFinalTermExceptionPossible(ctx: VisaInputContext): ValidationResult {
    const { termCredits, profile, f1Floor } = ctx;
    const floor = f1Floor ?? 12;
    const isF1 = profile.visaStatus === "f1";

    if (isF1 && profile.isFinalTerm === true && termCredits < floor) {
        if (profile.finalTermException === true) {
            return { status: "requires-approval", authority: "registrar" };
        }
        return {
            status: "fail",
            reason: `F-1 final-term enrollment below ${floor} credits without registrar-approved final-term exception.`,
        };
    }
    return { status: "pass", verifiedFrom: "DPR" };
}

// ---- Warning-level derivation ----

function deriveWarningLevel(axes: ValidationResult[]): "none" | "low" | "medium" | "high" {
    if (axes.some(a => a.status === "fail")) return "high";
    if (axes.some(a => a.status === "requires-approval")) return "medium";
    if (axes.some(a => a.status === "assumed-pass")) return "low";
    // "none" is reachable only after Phase 15 promotes the online/in-person
    // axes from `assumed-pass` to verified `pass`/`fail` based on FOSE
    // meetingPattern data. Pre-Phase-15, every call returns at most "low".
    return "none";
}

// ---- Citations derivation ----

function deriveCitations(
    result: Omit<VisaValidationResult, "overallWarningLevel" | "citations">,
    visaStatus: string | undefined,
): string[] {
    const cites: string[] = [];
    if (result.rclEligible.status === "requires-approval") {
        cites.push("OGS Policy: Reduced Course Load (RCL) for F-1 students");
    }
    if (result.cptConflict.status === "requires-approval") {
        cites.push("OGS Policy: Curricular Practical Training (CPT)");
    }
    if (
        result.finalTermExceptionPossible.status === "requires-approval" ||
        result.finalTermExceptionPossible.status === "fail"
    ) {
        cites.push("OGS Policy: F-1 Final-Term Enrollment Exception");
    }
    // Online-cap citation is F-1-specific. The axis returns assumed-pass for
    // every student pre-Phase-15, but only F-1 students are subject to the
    // 3-credits-per-term limit, so domestic students must not see this cite.
    if (
        visaStatus === "f1" &&
        result.onlineLimitSatisfied.status === "assumed-pass"
    ) {
        cites.push("OGS Policy: F-1 Online Course Limit (3 credits per term)");
    }
    return cites;
}

// ---- Public entry point ----

export function visaValidator(ctx: VisaInputContext): VisaValidationResult {
    const fullTimeSatisfied = evalFullTimeSatisfied(ctx);
    const creditMinimumSatisfied = evalCreditMinimumSatisfied(ctx);
    const onlineLimitSatisfied = evalOnlineLimitSatisfied(ctx);
    const inPersonMinimumSatisfied = evalInPersonMinimumSatisfied(ctx);
    const rclEligible = evalRclEligible(ctx);
    const cptConflict = evalCptConflict(ctx);
    const finalTermExceptionPossible = evalFinalTermExceptionPossible(ctx);

    const partialResult = {
        fullTimeSatisfied,
        creditMinimumSatisfied,
        onlineLimitSatisfied,
        inPersonMinimumSatisfied,
        rclEligible,
        cptConflict,
        finalTermExceptionPossible,
    };

    const allAxes: ValidationResult[] = [
        fullTimeSatisfied,
        creditMinimumSatisfied,
        onlineLimitSatisfied,
        inPersonMinimumSatisfied,
        rclEligible,
        cptConflict,
        finalTermExceptionPossible,
    ];

    return {
        ...partialResult,
        overallWarningLevel: deriveWarningLevel(allAxes),
        citations: deriveCitations(partialResult, ctx.profile.visaStatus),
    };
}
