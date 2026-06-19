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
// Plan 37 follow-up — per-school PassFailConfig (client-safe).
// VERIFIED node-free: passFailDefaults.ts has ZERO imports beyond
// the `PassFailConfig` TYPE from @nyupath/shared (type-only, erased
// at runtime). The data is a static inline map; no node:fs / node:url /
// node:crypto / schoolConfigLoader / fileURLToPath in the transitive tree.
//
// `passFailForSchool(homeSchool)` lets page.tsx thread the school's
// `canElect` flag into `slotActionMatrix` so the Pass/Fail button is
// pre-disabled on the CLIENT at a canElect:false school (e.g. Tandon)
// instead of showing enabled and receiving a server-side 422.
export { passFailForSchool } from "./data/passFailDefaults.js";
export type { PassFailConfig } from "@nyupath/shared";

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

// ------------------------------------------------------------
// Plan 37 (slot-editor F4) — the IP-changeability TERM classifier.
// VERIFIED node-free (same tree as slotActionMatrix above):
// ipCourseChangeability.ts + temporalContext.ts import only
// academicCalendar.ts (zero imports) + dpr/schema.ts (zod) — no
// node:fs / node:crypto / fileURLToPath. Safe to bundle for the browser.
//
// page.tsx (CLIENT) needs to classify a whole TERM's add/drop window
// (not a single slot) to decide whether the per-term "+ Add course"
// control is offered (FUTURE → free; current in add/drop → hedged;
// current past add/drop → hidden). It calls `classifyIpChangeability`
// with `deriveTemporalContext(dpr, { now })` directly — both must be
// importable WITHOUT touching the engine barrel.
export { classifyIpChangeability } from "./dpr/ipCourseChangeability.js";
export { deriveTemporalContext } from "./dpr/temporalContext.js";

export type {
    IpChangeWindow,
    IpChangeabilityResult,
    ClassifyIpChangeabilityArgs,
} from "./dpr/ipCourseChangeability.js";
export type {
    DprTemporalContext,
    DeriveTemporalContextOptions,
} from "./dpr/temporalContext.js";
