// ============================================================
// computeDprFingerprint — DPR content hash (Phase 16 Task A)
// ============================================================
// Deterministic SHA256 over the *content-bearing* fields of a parsed
// DegreeProgressReport. Used by the Update-DPR route (Task 16.B) to
// decide whether a re-uploaded DPR meaningfully differs from the
// stored one. When the fingerprint matches the stored row's
// `dpr_fingerprint`, the route short-circuits with a no-op; when it
// differs, the existing forward schedule is dropped + replanned.
//
// Login does NOT invoke this helper. The login restore route just
// reads whatever's in `forward_schedules` for the current student.
//
// Algorithm:
//   1. Flatten each course-history row to a stable tuple
//      `${term}|${subject}|${catalogNbr}|${units}|${grade ?? ""}|${type}`.
//   2. Sort lexicographically — re-parsing the same PDF in a different
//      order must produce the same fingerprint.
//   3. JSON.stringify `{ courseHistory: <sorted>, cumulative, programs }`.
//   4. SHA256 → hex.
//
// Fields outside the canonical input (e.g., `_meta.parsedAt`,
// `header.preparedDate`, `requirementGroups`) do NOT participate in
// the fingerprint — those would force a re-plan every time the student
// re-uploads even when nothing meaningful changed (e.g., parser version
// bump).
//
// `advisorNotations` DO participate (DPR-3): an adviser waiver is a
// meaningful change to the student's degree audit — adding or removing
// one must trigger a re-plan.
// ============================================================

import { createHash } from "node:crypto";
import type { DegreeProgressReport } from "./schema.js";

export function computeDprFingerprint(report: DegreeProgressReport): string {
    const canonical = JSON.stringify({
        courseHistory: [...report.courseHistory]
            .map((r) => `${r.term}|${r.subject}|${r.catalogNbr}|${r.units}|${r.grade ?? ""}|${r.type}`)
            .sort(),
        cumulative: report.cumulative,
        programs: report.programs ?? [],
        advisorNotations: report.advisorNotations ?? [],
    });
    return createHash("sha256").update(canonical).digest("hex");
}
