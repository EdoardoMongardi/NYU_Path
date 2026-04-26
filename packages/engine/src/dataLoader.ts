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
export { loadDepartmentConfig, type DepartmentConfig } from "./data/departmentLoader.js";
