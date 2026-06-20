// ============================================================
// sectionMaterialization/statusHelpers.ts — Phase 38 Task G1
// ============================================================
// FOSE enrollment-status predicates. Phase 38 splits the old
// `isOpenStatus` (which conflated `"O"` and `"W"`): a waitlist
// section is now distinct from an open one. Three predicates:
//   - isAvailableStatus → O or W  (the "keep in the pool" filter;
//     a W is still usable via the auto-swap backup, §2①(d))
//   - isOpenStatus      → O only  (truly open — no waitlist)
//   - isWaitlistStatus  → W only
//
// Status codes (verified against the FOSE schema):
//   "O" = open, "W" = waitlist, "C" = closed, "A" = active (pre-reg).
// ============================================================

/** O or W — the section is usable (open, or waitlist with a backup). */
export function isAvailableStatus(status: string): boolean {
    return status === "O" || status === "W";
}

/** O only — truly open, no waitlist. */
export function isOpenStatus(status: string): boolean {
    return status === "O";
}

/** W only — waitlist. */
export function isWaitlistStatus(status: string): boolean {
    return status === "W";
}
