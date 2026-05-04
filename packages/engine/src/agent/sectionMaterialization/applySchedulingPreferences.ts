// ============================================================
// sectionMaterialization/applySchedulingPreferences.ts
// Phase 15 Task 5 — Decision #43
// ============================================================
// Phase-15 first reader of the Phase-14-defined SchedulingPreferences
// type. Applied BEFORE Decision #18's combination enumeration
// (cheaper to filter sections than to filter combinations).
//
// IMPORTANT: `strict: true` per entry → HARD filter (drop the
// section + record the elimination). `strict: false` → SOFT
// deboost in section ranking (multiplier in (0, 1]). The
// `strict` flag here is INDEPENDENT from Decision #42's
// hard-vs-soft constraint framing (see SchedulingPreferences
// docstring in @nyupath/shared/types).
//
// Decision #19's existing course-swap cascade fires when an
// unsatisfiable strict filter eliminates all sections of a
// course; this helper just REPORTS surviving=[] for that course
// — the orchestrator (Task 6) handles the cascade.
//
// Time-window overlap uses the same HALF-OPEN [start, end)
// semantics as conflictDetection.ts (`a.startMin < b.endMin
// && b.startMin < a.endMin`).
// ============================================================

import type { SchedulingPreferences, Day } from "@nyupath/shared";
import type { MeetingPattern, SectionView } from "./types.js";

export interface ApplyResult {
    /** Sections that survive every strict filter, in the input order. */
    surviving: SectionView[];
    /**
     * sectionId (= section.crn) → soft-rank multiplier in (0, ∞).
     * Typical range is (0, ~2] for a single matched preferTimeWindow,
     * but stacking multiple `preferTimeWindows` matches (each contributes
     * a `1 + 0.5*weight` factor) can push the multiplier above 2.
     * Sections with no soft contribution are OMITTED (default = 1.0
     * is implicit).
     */
    rerankWeights: Map<string, number>;
    /**
     * One entry per section dropped by the strict pass. `reason` is
     * a concrete human-readable string naming the strict entry +
     * the matching pattern, suitable for surfacing to the student
     * via the orchestrator's swap-cascade explanation.
     */
    eliminatedByStrict: Array<{ sectionId: string; reason: string }>;
}

// ---- Soft-pass tuning constants ----
//
// These constants are local to this module by design — they are
// shape-defining heuristic weights, not a domain configuration
// surface. If a future phase needs to tune these, expose them
// through SchedulingPreferences itself rather than via a global.
//
// Rationale for the chosen magnitudes:
//   • The penalties leave headroom for stacking 2–3 mismatches
//     before a section is effectively dropped from the top of
//     rerank (0.7^3 ≈ 0.34 — still visible to the ranker, not zero).
//   • The boost is significant but bounded — a single max-weight
//     preferTimeWindow yields a 1.5× multiplier, which is enough
//     to pull a matching section above an otherwise-equal rival
//     without flattening the rest of the pool.
//   • The 180-min long-block floor is taken directly from the
//     Decision #43 spec phrase "≥3-hour back-to-back blocks".
const AVOID_DAYS_SOFT_PENALTY = 0.7;          // ~30% downweight per soft avoidDay match — see headroom rationale above
const AVOID_TIMEWINDOW_SOFT_PENALTY = 0.7;    // same ~30% downweight applies to soft avoidTimeWindows for symmetry
const LONG_BLOCK_SOFT_PENALTY = 0.7;          // same ~30% downweight when a ≥3h consecutive block is detected (always soft per Decision #43)
const PREFER_BOOST_BASE = 1.0;                // multiplier baseline; final = BASE + PER_WEIGHT * weight
const PREFER_BOOST_PER_WEIGHT = 0.5;          // max user weight=1.0 → 1.5× multiplier — significant but not flattening; multiple stacking matches still bounded
const LONG_BLOCK_THRESHOLD_MIN = 180;         // ≥3-hour back-to-back blocks (Decision #43 spec phrase)
const ALL_WEEKDAYS: Day[] = ["M", "Tu", "W", "Th", "F"];

// ---- Time / day helpers ----

/**
 * True iff [aStart, aEnd) overlaps [bStart, bEnd) with half-open
 * semantics: boundary touch (aEnd === bStart) is NOT overlap.
 */
function intervalsOverlap(
    aStart: number, aEnd: number,
    bStart: number, bEnd: number,
): boolean {
    return aStart < bEnd && bStart < aEnd;
}

/**
 * True iff section meets on the given day at any point.
 */
function meetsOnDay(section: SectionView, day: Day): boolean {
    for (const p of section.meetingPatterns) {
        if (p.day === day) return true;
    }
    return false;
}

/**
 * Find the first MeetingPattern in `section` that intersects the
 * provided window (days × time interval). Half-open semantics.
 */
function firstWindowMatch(
    section: SectionView,
    window: { days: Day[]; startMin: number; endMin: number },
): MeetingPattern | undefined {
    const daySet = new Set<string>(window.days);
    for (const p of section.meetingPatterns) {
        if (!daySet.has(p.day)) continue;
        if (intervalsOverlap(p.startMin, p.endMin, window.startMin, window.endMin)) {
            return p;
        }
    }
    return undefined;
}

/**
 * True iff `section` has at least one pair of MeetingPatterns on
 * the same day whose total back-to-back duration ≥ threshold.
 *
 * Definition: "back-to-back" means same day AND patternA ends at
 * the same minute or later than patternB starts (exact boundary
 * touch is a back-to-back link). A "chain" must contain ≥2
 * patterns to qualify — a single long meeting (e.g. a one-shot
 * 3-hour studio class) is NOT flagged here, matching the function
 * name `hasLongConsecutiveBlock` and the Decision #43 spec phrase
 * "≥3-hour back-to-back blocks" (which implies stitching ≥2
 * meetings together).
 *
 * This is a heuristic interpretation of `avoidConsecutiveLongBlocks`
 * — the schema doesn't pin a numeric threshold, but the spec says
 * "≥3-hour back-to-back blocks", so 180 minutes is the floor.
 */
function hasLongConsecutiveBlock(section: SectionView): boolean {
    // Group patterns by day, sort by startMin, scan for chained back-to-back duration.
    const byDay = new Map<Day, MeetingPattern[]>();
    for (const p of section.meetingPatterns) {
        const arr = byDay.get(p.day) ?? [];
        arr.push(p);
        byDay.set(p.day, arr);
    }
    for (const [, patterns] of byDay) {
        patterns.sort((a, b) => a.startMin - b.startMin);
        let chainStart = -1;
        let chainEnd = -1;
        let chainCount = 0;        // # of patterns currently stitched into the chain
        for (const p of patterns) {
            if (chainEnd >= 0 && p.startMin <= chainEnd) {
                // Back-to-back (or overlap): extend the chain
                chainEnd = Math.max(chainEnd, p.endMin);
                chainCount += 1;
            } else {
                // Close out previous chain, start a new one. Only flag
                // chains of ≥2 patterns — a single long meeting is not
                // a "consecutive" block.
                if (
                    chainCount >= 2 &&
                    chainEnd - chainStart >= LONG_BLOCK_THRESHOLD_MIN
                ) {
                    return true;
                }
                chainStart = p.startMin;
                chainEnd = p.endMin;
                chainCount = 1;
            }
        }
        if (
            chainCount >= 2 &&
            chainEnd - chainStart >= LONG_BLOCK_THRESHOLD_MIN
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Format a MeetingPattern for use in an elimination `reason`
 * string. Stable, machine-grep-friendly form.
 */
function formatPattern(p: MeetingPattern): string {
    return `MeetingPattern{day:${p.day},startMin:${p.startMin},endMin:${p.endMin}}`;
}

/**
 * True iff `prefs` has no consequential entry. Treats the
 * undefined and `{}` cases identically.
 */
function isPrefsEmpty(prefs: SchedulingPreferences): boolean {
    return (
        (prefs.avoidDays === undefined || prefs.avoidDays.length === 0) &&
        (prefs.avoidTimeWindows === undefined || prefs.avoidTimeWindows.length === 0) &&
        (prefs.preferTimeWindows === undefined || prefs.preferTimeWindows.length === 0) &&
        prefs.desiredFreeDay === undefined &&
        !prefs.avoidConsecutiveLongBlocks
    );
}

// ---- Strict-pass helpers ----

/**
 * Returns the elimination reason if `section` violates ANY strict
 * entry, else undefined.
 */
function strictEliminationReason(
    section: SectionView,
    prefs: SchedulingPreferences,
    desiredFreeDay: Day | undefined,
): string | undefined {
    // 1. Strict avoidDays
    if (prefs.avoidDays) {
        for (const e of prefs.avoidDays) {
            if (!e.strict) continue;
            for (const p of section.meetingPatterns) {
                if (p.day === e.day) {
                    return `strict avoidDays ${e.day} matched ${formatPattern(p)}`;
                }
            }
        }
    }
    // 2. Strict avoidTimeWindows
    if (prefs.avoidTimeWindows) {
        for (const w of prefs.avoidTimeWindows) {
            if (!w.strict) continue;
            const hit = firstWindowMatch(section, w);
            if (hit) {
                return `strict avoidTimeWindow [${w.days.join(",")} ${w.startMin}-${w.endMin}] matched ${formatPattern(hit)}`;
            }
        }
    }
    // 3. desiredFreeDay (concrete day already resolved by caller)
    if (desiredFreeDay !== undefined && prefs.desiredFreeDay?.strict === true) {
        for (const p of section.meetingPatterns) {
            if (p.day === desiredFreeDay) {
                return `strict desiredFreeDay ${desiredFreeDay} matched ${formatPattern(p)}`;
            }
        }
    }
    return undefined;
}

/**
 * Resolve `desiredFreeDay.day` to a concrete weekday.
 *
 * Concrete day → return it as-is.
 * "any"        → pick the day from M..F that yields the FEWEST
 *                strict eliminations among `sections`. Ties
 *                resolved by M < Tu < W < Th < F (earliest day
 *                wins). Returns undefined if every weekday would
 *                eliminate every section (no help, no choice).
 */
function resolveDesiredFreeDay(
    sections: SectionView[],
    prefs: SchedulingPreferences,
): Day | undefined {
    const cfg = prefs.desiredFreeDay;
    if (!cfg) return undefined;
    if (cfg.day !== "any") return cfg.day;

    // Pick the day in M..F that minimizes drops (= maximizes survivors).
    // We count how many sections meet on each candidate day; the day with
    // the FEWEST meeting sections wins.
    let bestDay: Day | undefined;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const day of ALL_WEEKDAYS) {
        let count = 0;
        for (const s of sections) {
            if (meetsOnDay(s, day)) count += 1;
        }
        if (count < bestCount) {
            bestCount = count;
            bestDay = day;
        }
    }
    return bestDay;
}

// ---- Soft-pass weight computation ----

function computeSoftMultiplier(
    section: SectionView,
    prefs: SchedulingPreferences,
): number {
    let multiplier = 1.0;

    // Soft avoidDays
    if (prefs.avoidDays) {
        for (const e of prefs.avoidDays) {
            if (e.strict) continue;
            if (meetsOnDay(section, e.day)) {
                multiplier *= AVOID_DAYS_SOFT_PENALTY;
            }
        }
    }

    // Soft avoidTimeWindows
    if (prefs.avoidTimeWindows) {
        for (const w of prefs.avoidTimeWindows) {
            if (w.strict) continue;
            if (firstWindowMatch(section, w) !== undefined) {
                multiplier *= AVOID_TIMEWINDOW_SOFT_PENALTY;
            }
        }
    }

    // preferTimeWindows (soft, by definition — boost upward)
    if (prefs.preferTimeWindows) {
        for (const w of prefs.preferTimeWindows) {
            if (firstWindowMatch(section, w) !== undefined) {
                multiplier *= PREFER_BOOST_BASE + PREFER_BOOST_PER_WEIGHT * w.weight;
            }
        }
    }

    // avoidConsecutiveLongBlocks (always soft per Decision #43 schema)
    if (prefs.avoidConsecutiveLongBlocks && hasLongConsecutiveBlock(section)) {
        multiplier *= LONG_BLOCK_SOFT_PENALTY;
    }

    return multiplier;
}

// ---- Public entry point ----

/**
 * Apply scheduling preferences to a section pool.
 *
 * 1. Identity short-circuit when `prefs` is undefined or empty.
 * 2. Strict pass: drop sections matching any strict entry; record
 *    one `eliminatedByStrict` entry per drop with a concrete reason.
 * 3. Soft pass: compute a multiplier (default 1.0; omitted from
 *    Map when no soft entry applies) by aggregating contributions
 *    via product. Aggregation is deterministic and commutative.
 *
 * Asynchronous sections (`isAsynchronous: true`, empty
 * meetingPatterns) are pure pass-through: every day/time-based
 * filter is vacuously satisfied (no meeting times to violate).
 */
export function applySchedulingPreferences(
    sections: SectionView[],
    prefs: SchedulingPreferences | undefined,
): ApplyResult {
    if (!prefs || isPrefsEmpty(prefs)) {
        return {
            surviving: sections,
            rerankWeights: new Map(),
            eliminatedByStrict: [],
        };
    }

    // Resolve desiredFreeDay first — "any" depends on the input section pool.
    const desiredFreeDay = resolveDesiredFreeDay(sections, prefs);

    const surviving: SectionView[] = [];
    const eliminatedByStrict: Array<{ sectionId: string; reason: string }> = [];

    // ---- Strict pass ----
    for (const section of sections) {
        const reason = strictEliminationReason(section, prefs, desiredFreeDay);
        if (reason !== undefined) {
            eliminatedByStrict.push({ sectionId: section.crn, reason });
        } else {
            surviving.push(section);
        }
    }

    // ---- Soft pass ----
    const rerankWeights = new Map<string, number>();
    for (const section of surviving) {
        const m = computeSoftMultiplier(section, prefs);
        if (m !== 1.0) {
            rerankWeights.set(section.crn, m);
        }
    }

    return { surviving, rerankWeights, eliminatedByStrict };
}
