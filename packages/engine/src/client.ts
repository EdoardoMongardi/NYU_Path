// ============================================================
// Client-safe engine entry — `@nyupath/engine/client`
// ============================================================
// Re-exports ONLY pure, Node-free symbols that are safe to bundle for the
// browser. Importing the MAIN barrel (`@nyupath/engine` → src/index.ts) from
// client code drags in server-only modules that execute Node APIs at module
// load time and cannot run in a browser, e.g.:
//   - data/schoolConfigLoader.ts + dataLoader.ts → node:fs / node:url
//     (`fileURLToPath(import.meta.url)` + `readFileSync` at top level)
//   - dpr/fingerprint.ts → node:crypto
// The engine package has no `sideEffects:false`, so webpack cannot tree-shake
// those re-exports out of a client bundle that touches the barrel — it either
// fails to compile (UnhandledSchemeError on `node:*`) or, if those builtins are
// stubbed, throws at runtime (`fileURLToPath is not a function`).
//
// CLIENT CODE MUST IMPORT FROM HERE (`@nyupath/engine/client`), NOT the barrel.
// Everything re-exported below lives in a module with ZERO Node imports
// (verified): courseId.ts and data/schoolDefaults.ts are pure.
//
// This is the "client-safe entry" seam; it does not touch the frozen engine
// contract (finalizeForwardSchedule / the 8-axis validator / the solver).

export { canonicalizeCourseId, canonicalizeCourseIdSet } from "./courseId.js";
export { SCHOOL_DISPLAY_NAMES } from "./data/schoolDefaults.js";

// ------------------------------------------------------------
// Plan 37 (slot-editor F3) — the slot-action matrix + the calendar const.
// VERIFIED node-free (transitive tree traced): slotActionMatrix.ts →
// {ipCourseChangeability,temporalContext,academicCalendar,dpr/schema}.ts →
// only `zod` + each other. academicCalendar.ts has ZERO imports;
// temporalContext + schema are type-only/zod; no node:fs / node:crypto /
// fileURLToPath / dataLoader / schoolConfigLoader / fingerprint / catalog
// /RAG anywhere in the tree. Safe to bundle for the browser.
//
// page.tsx (CLIENT) builds its per-slot `slotMatrix(slot, term)` via the
// runtime `slotActionMatrix` function + the `NYU_ACADEMIC_CALENDAR` const,
// so both must be importable WITHOUT touching the engine barrel.
export { slotActionMatrix } from "./agent/forwardSchedule/slotActionMatrix.js";
export { NYU_ACADEMIC_CALENDAR, campusForHomeSchool } from "./dpr/academicCalendar.js";

export type {
    SlotAction,
    SlotActionDecision,
    SlotActionMatrix,
    SlotActionMatrixArgs,
} from "./agent/forwardSchedule/slotActionMatrix.js";
export type { Campus, AcademicCalendar } from "./dpr/academicCalendar.js";
