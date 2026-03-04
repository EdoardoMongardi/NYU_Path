// ============================================================
// Availability Predictor — Predict course availability by season
// ============================================================
// Uses historical termsOffered data from the master catalog to
// predict whether a course will be available in a future term.
// ============================================================

import { generateTermCode } from "../api/nyuClassSearch.js";

export type AvailabilityConfidence = "confirmed" | "likely" | "uncertain";

export interface AvailabilityResult {
    courseId: string;
    /** Whether the course is expected to be available */
    available: boolean;
    /** Confidence level */
    confidence: AvailabilityConfidence;
    /** Human-readable reason */
    reason: string;
}

interface CatalogEntryWithTerms {
    courseId: string;
    termsOffered: string[];
}

/**
 * Extract the season from a FOSE term code.
 * Term codes: last digit 4=spring, 6=summer, 8=fall
 */
function getSeason(termCode: string): "spring" | "summer" | "fall" | null {
    const lastDigit = termCode.charAt(termCode.length - 1);
    if (lastDigit === "4") return "spring";
    if (lastDigit === "6") return "summer";
    if (lastDigit === "8") return "fall";
    return null;
}

/**
 * Check if the FOSE API has data for a given term.
 * Quick HEAD-style check: search for 1 result.
 */
export async function isTermPublished(termCode: string): Promise<boolean> {
    try {
        const response = await fetch(
            "https://bulletins.nyu.edu/class-search/api/?page=fose&route=search",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    other: { srcdb: termCode },
                    criteria: [{ field: "keyword", value: "CSCI-UA" }],
                }),
            }
        );
        if (!response.ok) return false;
        const data = await response.json() as { count: number };
        return data.count > 0;
    } catch {
        return false;
    }
}

/**
 * Predict availability for a single course in a target term.
 *
 * Logic:
 * 1. If the targetTerm is in termsOffered → confirmed
 * 2. If the course was offered in the same season in ≥2 of the past terms → likely
 * 3. If offered in same season only once → uncertain (but available = true)
 * 4. Never offered in this season → uncertain (available = false)
 */
export function predictAvailability(
    course: CatalogEntryWithTerms,
    targetTermCode: string,
    publishedTerms?: Set<string>
): AvailabilityResult {
    // 1. Confirmed: course is in this term's data
    if (course.termsOffered.includes(targetTermCode)) {
        return {
            courseId: course.courseId,
            available: true,
            confidence: "confirmed",
            reason: "Listed in course schedule",
        };
    }

    // If the target term IS published and course NOT in it → confirmed unavailable
    if (publishedTerms?.has(targetTermCode)) {
        return {
            courseId: course.courseId,
            available: false,
            confidence: "confirmed",
            reason: "Not listed in published schedule",
        };
    }

    // 2. Predict from history: check same-season pattern
    const targetSeason = getSeason(targetTermCode);
    if (!targetSeason) {
        return {
            courseId: course.courseId,
            available: false,
            confidence: "uncertain",
            reason: "Unknown term format",
        };
    }

    const sameSeasonTerms = course.termsOffered.filter(
        t => getSeason(t) === targetSeason
    );

    if (sameSeasonTerms.length >= 2) {
        return {
            courseId: course.courseId,
            available: true,
            confidence: "likely",
            reason: `Offered in ${targetSeason} for ${sameSeasonTerms.length} recent terms`,
        };
    }

    if (sameSeasonTerms.length === 1) {
        return {
            courseId: course.courseId,
            available: true,
            confidence: "uncertain",
            reason: `Offered in ${targetSeason} once recently — may or may not repeat`,
        };
    }

    // Never offered in this season
    return {
        courseId: course.courseId,
        available: false,
        confidence: "uncertain",
        reason: `Never offered in ${targetSeason} in recent history`,
    };
}

/**
 * Batch predict availability for search results.
 * Returns results annotated with availability info.
 */
export function predictAvailabilityBatch(
    courses: CatalogEntryWithTerms[],
    targetTermCode: string,
    publishedTerms?: Set<string>
): Map<string, AvailabilityResult> {
    const results = new Map<string, AvailabilityResult>();
    for (const c of courses) {
        results.set(c.courseId, predictAvailability(c, targetTermCode, publishedTerms));
    }
    return results;
}
