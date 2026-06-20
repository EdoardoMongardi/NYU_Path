// ============================================================
// sectionMaterialization/statusHelpers.ts — Phase 38 Task G1
// ============================================================
// FOSE enrollment-status predicates. Phase 38 splits the old
// `isOpenStatus` (which conflated `"O"` and `"W"`):
//   - isAvailableStatus → O, W, or A  (the "keep in the pool" filter:
//     a usable, non-closed section)
//   - isOpenStatus      → O only  (a CONFIRMED open seat)
//   - isWaitlistStatus  → W only
//
// Status codes:
//   "O" = open, "W" = waitlist, "C" = closed,
//   "A" = Active/offered, SEAT STATUS UNKNOWN.
//
// CRITICAL (verified 2026-06-20): the public FOSE/bulletins API returns
// `stat:"A"` for EVERY live section — including past terms — and never
// O/W/C. Live open/waitlist/closed lives only in authenticated
// Albert/PeopleSoft (out of reach for this read-only adviser). So in
// practice `"A"` is the ONLY live status, and it is USABLE for
// time-conflict feasibility (the section exists + has a meeting time);
// seat availability is HEDGED, not asserted. Excluding "A" dropped every
// live section → zero candidates. O/W/C handling is retained for the
// case where real status is known (e.g. student-supplied from Albert).
// ============================================================

/** O, W, or A — a usable (non-closed) section: keep it in the pool. */
export function isAvailableStatus(status: string): boolean {
    return status === "O" || status === "W" || status === "A";
}

/** O only — truly open, no waitlist. */
export function isOpenStatus(status: string): boolean {
    return status === "O";
}

/** W only — waitlist. */
export function isWaitlistStatus(status: string): boolean {
    return status === "W";
}
