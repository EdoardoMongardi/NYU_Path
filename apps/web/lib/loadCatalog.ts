// ============================================================
// loadCatalog — module-cached engine catalog for the chat session
// ============================================================
// The chat route hydrates the ToolSession with the bundled course +
// prereq catalogs via getCatalog(). The forward planner reads
// course titles/credits + prereqs from these maps.
//
// Cached at module scope: the JSON files are read on first use and
// reused for every request.
// ============================================================

import { loadCourses, loadPrereqs } from "@nyupath/engine";
import type { Course, Prerequisite } from "@nyupath/shared";

export interface SessionCatalog {
    courses: Course[];
    prereqs: Prerequisite[];
}

let cached: SessionCatalog | null = null;

/**
 * Return the engine catalog (courses + prereqs), loading it from disk
 * on first call and caching it for the process lifetime. File-read
 * failures propagate (same as `loadSchoolConfig`).
 */
export function getCatalog(): SessionCatalog {
    if (cached) return cached;
    cached = {
        courses: loadCourses(),
        prereqs: loadPrereqs(),
    };
    return cached;
}

/** Test hook — clears the module cache so a test can re-load. */
export function _clearCatalogCache(): void {
    cached = null;
}
