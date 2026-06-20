// ============================================================
// sectionMaterialization/ipSections.ts — Phase 38 #2
// ============================================================
// Resolve the student's ALREADY-REGISTERED (IP) course sections into
// fixed occupied time blocks, so `materialize_feasible` can keep the
// REMAINING courses' candidates conflict-free against what the student
// is already enrolled in this term.
//
// Why this is needed: the DPR shows WHICH courses are in-progress for
// the near term, but NOT which section (CRN / meeting time) — that
// lives only in authenticated Albert. So the student supplies it (the
// §2.6 / CORE-RULE-13 elicitation): a CRN (looked up live in FOSE) or
// the meeting times directly. Anything we can't resolve is reported
// back so the caller HEDGES ("verify against your Albert schedule")
// rather than silently ignoring a real time conflict.
//
// Pure given its injected `searchFn` (defaults to the live FOSE client).
// ============================================================

import { searchCourses as defaultSearchCourses } from "../../api/nyuClassSearch.js";
import { fetchAndMapCourse } from "./materialize.js";
import { parseMeetingTimes } from "./parseMeetingTimes.js";
import { FoseCache } from "./foseCache.js";
import type { MeetingPattern } from "./types.js";

/** A student-supplied already-registered (IP) course section. */
export interface IpSectionInput {
    courseId: string;
    /** The registered section's CRN (looked up live in FOSE for its times). */
    crn?: string;
    /** Raw FOSE-style meeting string, if the student gave times directly. */
    meets?: string;
    /** FOSE meetingTimes JSON, if available. */
    meetingTimes?: string;
}

export interface ResolveIpSectionsResult {
    /** All resolved occupied meeting blocks (to feed `occupiedBlocks`). */
    blocks: MeetingPattern[];
    /** courseIds whose section could not be resolved (→ the caller hedges). */
    unresolved: string[];
}

interface ResolveDeps {
    searchFn?: (termCode: string, keyword: string) => Promise<unknown[]>;
    cache?: FoseCache<unknown[]>;
}

const SHARED_CACHE = new FoseCache<unknown[]>();

/**
 * Resolve IP sections → fixed occupied blocks. For each:
 *   1. If meeting times were supplied (meetingTimes/meets) → parse them.
 *   2. Else if a CRN was supplied → look the course up live and use the
 *      matching section's parsed times.
 *   3. Otherwise → unresolved (the caller hedges).
 */
export async function resolveIpSectionsToBlocks(
    ipSections: IpSectionInput[],
    termCode: string,
    deps: ResolveDeps = {},
): Promise<ResolveIpSectionsResult> {
    const searchFn = deps.searchFn ?? (defaultSearchCourses as (t: string, k: string) => Promise<unknown[]>);
    const cache = deps.cache ?? SHARED_CACHE;

    const blocks: MeetingPattern[] = [];
    const unresolved: string[] = [];

    for (const ip of ipSections) {
        // 1. Student-supplied times take precedence (no FOSE call).
        if (ip.meetingTimes !== undefined || ip.meets !== undefined) {
            const parsed = parseMeetingTimes(ip.meets ?? "", ip.meetingTimes);
            if (parsed.kind === "ok") {
                blocks.push(...parsed.patterns);
                continue;
            }
            // asynchronous = no meeting time → nothing to avoid; resolved.
            if (parsed.kind === "asynchronous") continue;
            unresolved.push(ip.courseId);
            continue;
        }

        // 2. CRN → live lookup of the course's sections.
        if (ip.crn !== undefined && ip.crn !== "") {
            const { sections } = await fetchAndMapCourse(termCode, ip.courseId, searchFn, cache);
            const match = sections.find(s => s.crn === ip.crn);
            if (match && match.meetingPatterns.length > 0) {
                blocks.push(...match.meetingPatterns);
                continue;
            }
            // CRN matched an async section (no blocks) → resolved, nothing to avoid.
            if (match && match.isAsynchronous) continue;
            unresolved.push(ip.courseId);
            continue;
        }

        // 3. No CRN, no times → can't resolve.
        unresolved.push(ip.courseId);
    }

    return { blocks, unresolved };
}
