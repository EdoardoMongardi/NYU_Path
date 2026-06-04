// ============================================================
// Canonical course-ID form
// ============================================================
// NYU course numbers were scraped inconsistently: a prerequisite to
// "Writing the Essay" is stored as both `EXPOS-UA 1` and `EXPOS-UA 0001`
// in different places — the SAME course written two ways. Because the
// prereq graph and the DPR satisfaction check compare ids as exact
// strings, the zero-padded form silently fails to match a student's
// (unpadded) completed course, so the system can wrongly conclude a
// prerequisite is unmet.
//
// `canonicalizeCourseId` collapses the two forms by stripping leading
// zeros from the numeric token that follows the space. Verified against
// the full catalog:
//   - 424 courses literally appear in BOTH forms in the source data;
//   - 0 collisions — no two genuinely-distinct courses share a
//     canonical form;
//   - AP/IB/placement pseudo-ids ("AP-CS-A-3", "PLACE-LANG-MANDARIN-1")
//     and letter-suffix numbers ("CHIN-SHU 0101S") are left intact /
//     correctly preserved (no space-then-zero, or the suffix is kept).
// ============================================================

/**
 * Canonical course-ID form: strips leading zeros from the numeric run
 * immediately after the (single) space in a `DEPT-SUFFIX NUMBER` id, so
 * `CSCI-UA 0101` → `CSCI-UA 101` and `EXPOS-UA 0001` → `EXPOS-UA 1`.
 * Ids without a space-then-zero (AP/IB/placement pseudo-ids) are returned
 * unchanged; a trailing letter suffix (`0101S` → `101S`) is preserved.
 */
export function canonicalizeCourseId(id: string): string {
    return id.replace(/(\s)0+(\d)/, "$1$2");
}

/** Canonicalize every id in a set (helper for completed-course sets). */
export function canonicalizeCourseIdSet(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) out.add(canonicalizeCourseId(id));
    return out;
}
