// ============================================================
// Data Loader — Load JSON data files
// ============================================================
//
// Phase 0/1 layering:
//   - loadCourses / loadPrereqs / loadPrograms still read the bundled
//     v1 datasets under `packages/engine/src/data/` (CS BA + CAS Core).
//   - loadSchoolConfig reads `data/schools/<schoolId>.json` at the repo
//     root, with Phase 0 `_meta` validation (§11.0.1). Re-exported from
//     `data/schoolConfigLoader.ts` so callers can `import { loadSchoolConfig }
//     from "@nyupath/engine/dataLoader"`.
//   - applicableCatalogYear / resolveProgramFile (Phase 0) are re-exported
//     so the same import path serves both CAS-bundled programs and the
//     forthcoming `data/programs/<school>/<programId>.json` files.
// ============================================================
import type { Course, Prerequisite, Program } from "@nyupath/shared";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

export function loadCourses(): Course[] {
    const raw = readFileSync(join(DATA_DIR, "courses.json"), "utf-8");
    return JSON.parse(raw) as Course[];
}

export function loadPrereqs(): Prerequisite[] {
    const raw = readFileSync(join(DATA_DIR, "prereqs.json"), "utf-8");
    return JSON.parse(raw) as Prerequisite[];
}

export function loadPrograms(): Program[] {
    const raw = readFileSync(join(DATA_DIR, "programs.json"), "utf-8");
    return JSON.parse(raw) as Program[];
}

export function loadProgram(programId: string, catalogYear?: string): Program | undefined {
    const programs = loadPrograms();
    return programs.find(
        (p) =>
            p.programId === programId &&
            (catalogYear ? p.catalogYear === catalogYear : true)
    );
}

// ---- Phase 1: school + per-school program loaders ----
export {
    loadSchoolConfig,
    loadSchoolConfigStrict,
    type SchoolConfigLoadResult,
} from "./data/schoolConfigLoader.js";
export {
    applicableCatalogYear,
    resolveProgramFile,
    type ResolveResult,
    type ResolveLogger,
} from "./data/catalogYearLoader.js";
export {
    loadProgramFromDataDir,
    type ProgramFromDataDirResult,
} from "./data/programLoader.js";
export { loadDepartmentConfig, type DepartmentConfig } from "./data/departmentLoader.js";

// ---- Phase 1 §11.0.2: precedence-rule resolver ----
//
// `resolveFact` is the canonical entry-point for any code that needs to
// answer "what is value X for this student?" when multiple data layers
// could disagree. The precedence order (highest authority first) is:
//
//   1. school config         data/schools/<school>.json
//   2. program config        data/programs/<school>/<program>.json
//   3. department config     data/departments/<school>/<dept>.json
//   4. course catalog        data/courses/*.json
//
// At v1.0 the function is a thin reducer: callers hand it the candidate
// values from each layer (already loaded) and it returns the
// highest-authority defined value plus a tie-record. The function does
// NOT do the loading — that stays in the per-layer loaders.

export type PrecedenceLayer = "school" | "program" | "department" | "course_catalog";

export interface FactCandidate<T> {
    layer: PrecedenceLayer;
    /** The value from this layer; undefined means "this layer doesn't define it" */
    value: T | undefined;
    /** Optional source path for log/audit reporting */
    source?: string;
    /** Optional ISO date when this layer was last verified (used for tie-breaking) */
    lastVerified?: string;
}

export interface ResolvedFact<T> {
    /** The winning value (undefined if no layer defined it) */
    value: T | undefined;
    /** Layer that won, or undefined when nothing defined it */
    winner?: PrecedenceLayer;
    /** Source path of the winning layer, if provided */
    source?: string;
    /** Other layers that ALSO defined a value, in precedence order */
    overridden: Array<{ layer: PrecedenceLayer; value: T; source?: string }>;
}

const LAYER_ORDER: PrecedenceLayer[] = ["school", "program", "department", "course_catalog"];

/**
 * Apply the §11.0.2 precedence rule to a set of candidate values.
 *
 * v1 behavior:
 *   - The first layer (in LAYER_ORDER) with a defined value wins.
 *   - Other defined layers are returned in `overridden` for audit logging.
 *   - Same-layer ties (e.g., two program files claiming authority over the
 *     same fact) are NOT handled here at v1 — callers feed at most one
 *     candidate per layer. §11.0.2 specifies a `lastVerified`-based
 *     tie-break that will be added when a real same-layer conflict surfaces.
 */
export function resolveFact<T>(candidates: FactCandidate<T>[]): ResolvedFact<T> {
    const byLayer = new Map<PrecedenceLayer, FactCandidate<T>>();
    for (const c of candidates) byLayer.set(c.layer, c);

    let winner: PrecedenceLayer | undefined;
    let value: T | undefined;
    let winnerSource: string | undefined;
    const overridden: Array<{ layer: PrecedenceLayer; value: T; source?: string }> = [];

    for (const layer of LAYER_ORDER) {
        const cand = byLayer.get(layer);
        if (!cand || cand.value === undefined) continue;
        if (winner === undefined) {
            winner = layer;
            value = cand.value;
            winnerSource = cand.source;
        } else {
            overridden.push({ layer, value: cand.value, source: cand.source });
        }
    }

    return { value, winner, source: winnerSource, overridden };
}
