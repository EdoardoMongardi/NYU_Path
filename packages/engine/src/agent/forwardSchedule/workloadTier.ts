/**
 * Phase 13 Decisions #24 + #35 — Workload-tier classifier + weight
 * modifier. Pure: deterministic from inputs; no I/O.
 *
 * Tier classification (Decision #24): derived from rule-satisfaction.
 *   - "must_take" against major program → "major-required"
 *   - "choose_n" against major program → "major-elective"
 *   - school-core ruleId             → "school-core"
 *   - "optional: true" / no rule     → "free-elective"
 *   - general-category placeholder   → "general-elective"
 *
 * Base weight per tier (Decision #24):
 *   major-required:   1.0
 *   major-elective:   1.0
 *   school-core:      1.0
 *   free-elective:    0.5
 *   general-elective: 0.6
 *
 * Decision #35 modifiers (stack additively, capped at +0.6):
 *   +0.2  W-suffix or writing-intensive
 *   +0.15 L-suffix or "Lab" in title
 *   +0.2  Course number ≥4000 (CAS/-UA) or ≥3000 (Tandon/-UY)
 *   +0.2  Capstone (≥3 prereq groups)
 */

import type { WorkloadTier, Prerequisite } from "@nyupath/shared";

export interface WorkloadTierClassifyArgs {
    courseId: string;
    /** Rule satisfactions used by this slot. Each entry is a rule ID. */
    satisfiesRules: string[];
    /** Major-program rule IDs mapped to their kind. */
    majorRuleKinds: Map<string, "must_take" | "choose_n">;
    /** School-core rule IDs. */
    schoolCoreRuleIds: Set<string>;
    /** General-category placeholder rule IDs. */
    generalCategoryRuleIds: Set<string>;
    /** Bulletin metadata for #35 modifiers. */
    bulletinTitle?: string;
    bulletinKeywords?: string[];
    /** Prereq entry used for capstone signal (≥3 prereq groups). */
    prereqsEntry?: Pick<Prerequisite, "prereqGroups">;
    /** Marks optional: true slots → "free-elective". */
    isOptional?: boolean;
}

export interface WorkloadTierResult {
    tier: WorkloadTier;
    weight: number;  // baseWeight + min(modifiers, 0.6)
}

/** Tier-precedence order (highest to lowest): major-required > major-elective > school-core > general-elective > free-elective */
const TIER_PRECEDENCE: Record<WorkloadTier, number> = {
    "major-required":  5,
    "major-elective":  4,
    "school-core":     3,
    "general-elective": 2,
    "free-elective":   1,
};

const BASE_WEIGHT: Record<WorkloadTier, number> = {
    "major-required":   1.0,
    "major-elective":   1.0,
    "school-core":      1.0,
    "free-elective":    0.5,
    "general-elective": 0.6,
};

const MAX_MODIFIER = 0.6;

/**
 * Classify a slot's workload tier and compute its weight.
 * Pure function — no I/O, no closures over module state.
 */
export function classifyWorkloadTier(args: WorkloadTierClassifyArgs): WorkloadTierResult {
    const tier = resolveTier(args);
    const baseWeight = BASE_WEIGHT[tier];
    const modifier = Math.min(computeModifier(args), MAX_MODIFIER);
    return { tier, weight: baseWeight + modifier };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveTier(args: WorkloadTierClassifyArgs): WorkloadTier {
    let best: WorkloadTier = "free-elective";

    // If optional and no rule match, stays free-elective.
    // We still allow rules to override up, so don't return early here.

    for (const ruleId of args.satisfiesRules) {
        const majorKind = args.majorRuleKinds.get(ruleId);
        if (majorKind === "must_take") {
            const candidate: WorkloadTier = "major-required";
            if (TIER_PRECEDENCE[candidate] > TIER_PRECEDENCE[best]) best = candidate;
        } else if (majorKind === "choose_n") {
            const candidate: WorkloadTier = "major-elective";
            if (TIER_PRECEDENCE[candidate] > TIER_PRECEDENCE[best]) best = candidate;
        } else if (args.schoolCoreRuleIds.has(ruleId)) {
            const candidate: WorkloadTier = "school-core";
            if (TIER_PRECEDENCE[candidate] > TIER_PRECEDENCE[best]) best = candidate;
        } else if (args.generalCategoryRuleIds.has(ruleId)) {
            const candidate: WorkloadTier = "general-elective";
            if (TIER_PRECEDENCE[candidate] > TIER_PRECEDENCE[best]) best = candidate;
        }
    }

    // isOptional explicitly overrides to free-elective only when no stronger rule exists.
    // Decision #24: "optional: true / no rule → free-elective".
    // If a major or school rule was found it already beats free-elective; isOptional is
    // effectively a fallback label for slots with no rule match.

    return best;
}

/** Parse the course-number integer from a courseId.
 *  E.g. "CSCI-UA 4700" → 4700; "CSCI-UA 4900W" → 4900; "CSCI-UY 3200" → 3200.
 *  Returns null if no numeric suffix found. */
function parseCourseNumber(courseId: string): number | null {
    // Matches optional space + digits immediately before an optional alphabetic tail
    const m = courseId.match(/[- ](\d+)[A-Za-z]*\s*$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
}

function isTandonCourse(courseId: string): boolean {
    return /-UY\b/i.test(courseId);
}

function hasWModifier(args: WorkloadTierClassifyArgs): boolean {
    // W suffix on courseId
    if (/W\s*$/.test(args.courseId)) return true;
    // bulletinKeywords
    const kws = args.bulletinKeywords ?? [];
    const writingPhrases = ["writing-intensive", "intensive writing", "expository writing"];
    return kws.some(k => writingPhrases.some(p => k.toLowerCase().includes(p)));
}

function hasLModifier(args: WorkloadTierClassifyArgs): boolean {
    // L suffix on courseId
    if (/L\s*$/.test(args.courseId)) return true;
    // "Lab" in bulletin title
    if (args.bulletinTitle && /\bLab\b/i.test(args.bulletinTitle)) return true;
    return false;
}

function hasAdvancedLevelModifier(args: WorkloadTierClassifyArgs): boolean {
    const num = parseCourseNumber(args.courseId);
    if (num === null) return false;
    if (isTandonCourse(args.courseId)) {
        return num >= 3000;
    }
    // CAS and other schools: ≥4000
    return num >= 4000;
}

function hasCapstoneModifier(args: WorkloadTierClassifyArgs): boolean {
    return (args.prereqsEntry?.prereqGroups?.length ?? 0) >= 3;
}

function computeModifier(args: WorkloadTierClassifyArgs): number {
    let mod = 0;
    if (hasWModifier(args)) mod += 0.2;
    if (hasLModifier(args)) mod += 0.15;
    if (hasAdvancedLevelModifier(args)) mod += 0.2;
    if (hasCapstoneModifier(args)) mod += 0.2;
    return mod;
}
