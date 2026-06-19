// ============================================================
// courseExists — catalog-presence check for the add route (E3)
// ============================================================
// SERVER-SIDE ONLY. Uses the same getCatalog() module-cached loader
// that the chat route uses, so we read and parse courses.json exactly
// once per process lifetime.
//
// canonicalizeCourseId (from @nyupath/engine) strips leading zeros from
// the numeric portion so "CSCI-UA 0101" is treated the same as the
// catalog entry "CSCI-UA 101".
// ============================================================

import { canonicalizeCourseId } from "@nyupath/engine";
import { getCatalog } from "./loadCatalog.js";

/** Module-level memo: built once, reused for the process lifetime. */
let catalogIdSet: Set<string> | null = null;

function getCatalogIdSet(): Set<string> {
    if (catalogIdSet) return catalogIdSet;
    const { courses } = getCatalog();
    catalogIdSet = new Set(courses.map((c) => canonicalizeCourseId(c.id)));
    return catalogIdSet;
}

/**
 * Returns true when `courseId` (after canonicalization) is present in
 * the NYU undergraduate planning catalog; false otherwise.
 *
 * Synchronous — the catalog loader is sync + cached at module scope.
 *
 * @param courseId — raw course id (e.g. "CSCI-UA 0101" or "CSCI-UA 101")
 */
export function courseExists(courseId: string): boolean {
    return getCatalogIdSet().has(canonicalizeCourseId(courseId));
}

/** Test hook — resets the module-level memo so tests can reload. */
export function _clearCourseExistsCache(): void {
    catalogIdSet = null;
}
