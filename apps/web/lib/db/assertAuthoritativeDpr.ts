// ============================================================
// assertAuthoritativeDpr — G0.2 snapshot-integrity guard (re-export)
// ============================================================
// The canonical guard lives in the engine (single source of truth)
// — packages/engine/src/persistence/profileStore.ts. The web
// persistence layer re-exports it here so PostgresProfileStore (and
// any other web write-site) can import it from a stable local path
// without reaching into engine internals. web → engine is the normal
// dependency direction; there is exactly ONE copy of the rule/message.
//
// Invariant: only a DPR with reportKind === "dpr" may be persisted as
// the canonical students.parsed_dpr snapshot. A what-if DPR (Albert
// "What-If" / "Career Simulation" PDF, or an in-memory assumption
// transform such as applyWithdrawalToDpr / applyPassFailToDpr) is a
// *hypothetical* and must never overwrite the authoritative record.
// ============================================================

export { assertAuthoritativeDpr } from "@nyupath/engine";
