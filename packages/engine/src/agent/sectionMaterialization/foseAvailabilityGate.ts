// ============================================================
// sectionMaterialization/foseAvailabilityGate.ts — Phase 15 Task 3
// ============================================================
// Per-call FOSE data-state classifier.
//
// Decision #16: each `materialize_sections` call inspects FOSE's
// response to classify state. NOT a static window assumption.
//
// Schema note (Task 0/1 correction):
//   Real FOSE uses `meets` + `meetingTimes` (not `hours`).
//   `parseMeetingTimes(meets, meetingTimes)` per Task 1 signature.
//
// Classification rules:
//   "unavailable": sections.length === 0
//   "partial":     ≥1 section but < 50% parseable (ok OR asynchronous)
//   "full":        ≥ 50% parseable
//
// "asynchronous" counts as parseable: it is a definitive answer
// ("this course has no meeting time — online/async"), not a data gap.
// ============================================================

import type { AvailabilityState } from "./types.js";
import { parseMeetingTimes } from "./parseMeetingTimes.js";

/**
 * Minimal view of a FOSE section result needed by the gate.
 * Fields match the real FOSE API shape (verified against 27 fixtures 2026-05-03).
 * Both fields are optional because FOSE sometimes omits them.
 */
export interface FoseSection {
    /** Human-readable meeting string from FOSE `meets` field. */
    meets?: string;
    /**
     * Structured JSON array string from FOSE `meetingTimes` field.
     * Shape: `[{"meet_day":"0","start_time":"930","end_time":"1045"},...]`
     */
    meetingTimes?: string;
}

/**
 * Classify the availability state of a FOSE result set.
 *
 * @param sections - Array of FOSE section results for one query.
 * @returns `AvailabilityState`:
 *   - "unavailable": no sections returned.
 *   - "partial":     sections present but < 50% have parseable schedules.
 *   - "full":        ≥ 50% of sections have parseable schedules.
 */
export function classifyAvailability(sections: FoseSection[]): AvailabilityState {
    if (sections.length === 0) return "unavailable";

    let parseable = 0;
    for (const s of sections) {
        const result = parseMeetingTimes(s.meets ?? "", s.meetingTimes);
        if (result.kind === "ok" || result.kind === "asynchronous") {
            parseable++;
        }
    }

    const ratio = parseable / sections.length;
    return ratio >= 0.5 ? "full" : "partial";
}
