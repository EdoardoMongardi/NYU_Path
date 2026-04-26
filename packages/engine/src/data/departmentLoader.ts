// ============================================================
// Department Config Loader — STUB (ARCHITECTURE.md §11.9)
// ============================================================
// Phase 0 deliverable: reserve the precedence slot for department
// configs without freezing the schema. Schema is deferred until ≥3
// real department conflicts are observed in production logs.
//
// This loader returns null for ALL inputs at v1.0. The audit engine
// works correctly with null department configs — it just uses the
// program JSON directly.
// ============================================================

export interface DepartmentConfig {
    // Schema deliberately empty at v1.0. Do NOT add hypothetical fields here.
    // See ARCHITECTURE.md §11.9 for the trigger that creates the schema.
    readonly _placeholder?: never;
}

/**
 * Look up a department config. Returns null at v1.0.
 *
 * @param school   e.g. "cas", "tandon"
 * @param dept     e.g. "computer_science"
 * @returns        null at v1.0; future: DepartmentConfig | null
 */
export function loadDepartmentConfig(
    _school: string,
    _dept: string,
): DepartmentConfig | null {
    return null;
}
