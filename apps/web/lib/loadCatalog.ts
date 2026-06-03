// ============================================================
// loadCatalog — module-cached engine catalog for the chat session
// ============================================================
// Phase A (improvement plan): the chat route historically never
// populated `session.programs` / `session.courses` / `session.prereqs`,
// so `check_overlap` always rejected ("Programs catalog not loaded")
// and any rule-engine-backed path was unreachable. This helper loads
// the engine's bundled catalog ONCE per server process and hands the
// chat route the shapes the ToolSession expects.
//
// Cached at module scope: the JSON files (courses ~32KB, prereqs ~860KB,
// programs ~10KB) are read on first use and reused for every request.
// ============================================================

import { loadCourses, loadPrereqs, loadPrograms } from "@nyupath/engine";
import type { Course, Prerequisite, Program } from "@nyupath/shared";

export interface SessionCatalog {
    courses: Course[];
    prereqs: Prerequisite[];
    /** Programs keyed by `programId`, the shape `ToolSession.programs` expects. */
    programs: Map<string, Program>;
}

let cached: SessionCatalog | null = null;

/**
 * Return the engine catalog (courses + prereqs + programs map), loading
 * it from disk on first call and caching it for the process lifetime.
 * Never throws on an empty dataset — callers get whatever the loaders
 * return. File-read failures propagate (same as `loadSchoolConfig`).
 */
export function getCatalog(): SessionCatalog {
    if (cached) return cached;
    const programs = new Map<string, Program>();
    for (const p of loadPrograms()) programs.set(p.programId, p);
    cached = {
        courses: loadCourses(),
        prereqs: loadPrereqs(),
        programs,
    };
    return cached;
}

/** Test hook — clears the module cache so a test can re-load. */
export function _clearCatalogCache(): void {
    cached = null;
}
