// ============================================================
// assertAuthoritativeDpr — G0.2 snapshot-integrity guard
// ============================================================
// Single chokepoint that enforces the invariant: only a DPR
// with reportKind === "dpr" may be persisted as the canonical
// students.parsed_dpr snapshot.
//
// A what-if DPR (Albert "What-If" / "Career Simulation" PDF,
// or a future in-memory assumption transform such as
// applyWithdrawalToDpr / applyPassFailToDpr) represents a
// *hypothetical* registrar view and must never overwrite the
// student's authoritative record.
//
// Call this at every persist-chokepoint that writes to
// parsed_dpr (both InMemoryProfileStore and PostgresProfileStore)
// before the write is issued.
// ============================================================

import type { DegreeProgressReport } from "@nyupath/engine";

/**
 * Throws if `dpr.reportKind` is not `"dpr"`.
 *
 * @throws Error — message includes "refusing to persist a
 *   non-authoritative (what_if) DPR as the student snapshot"
 *   so callers can pattern-match in tests and logs.
 */
export function assertAuthoritativeDpr(dpr: DegreeProgressReport): void {
    if (dpr.reportKind !== "dpr") {
        throw new Error(
            `[snapshot-integrity] refusing to persist a non-authoritative (${dpr.reportKind}) DPR as the student snapshot. ` +
            `Only reportKind === "dpr" may be written to students.parsed_dpr. ` +
            `Use a what-if session context instead — never overwrite the authoritative DPR column.`,
        );
    }
}
