// ============================================================
// Catalog-Year Pinning Loader (ARCHITECTURE.md §11.0.3)
// ============================================================
// File-naming convention for program JSONs:
//   data/programs/<school>/<programId>.json                   ← current
//   data/programs/<school>/<programId>__<YYYY-YYYY>.json      ← snapshot
//
// Resolver behavior:
//   - exact match on requested catalogYear → return that file path
//   - else: nearest earlier snapshot wins (per §11.0.3)
//   - if NO snapshot at-or-before the requested year exists, fall back
//     to the current (unsuffixed) file
//   - Phase 0 logs a `catalog_year_fallback` event when fallback occurs
//
// IMPORTANT: this module only RESOLVES file paths. It does not read or
// parse the file. JSON loading + _meta validation is Phase 1's dataLoader.
// ============================================================

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/programs/ lives at the repo root, not inside packages/engine/src/data/.
// Resolve relative to this file: <repo>/packages/engine/src/data/ → <repo>/data/programs/
const REPO_DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const PROGRAMS_DIR = join(REPO_DATA_DIR, "programs");

const SNAPSHOT_RE = /__(\d{4})-(\d{4})\.json$/;
const CATALOG_YEAR_RE = /^(\d{4})-(\d{4})$/;

export type ResolveResult =
    | { kind: "exact"; path: string; catalogYear: string }
    | { kind: "earlier_snapshot"; path: string; catalogYear: string; requested: string }
    | { kind: "current_fallback"; path: string; requested: string }
    | { kind: "not_found"; programId: string; school: string; requested: string };

export type ResolveLogger = (event: {
    kind: "catalog_year_fallback" | "catalog_year_not_found";
    programId: string;
    school: string;
    requested: string;
    chosenPath?: string;
    chosenCatalogYear?: string;
}) => void;

/**
 * Resolve the program JSON file path for a given (school, programId, catalogYear).
 *
 * Precedence:
 *   1. exact snapshot:    <programsDir>/<school>/<programId>__<YYYY-YYYY>.json
 *   2. earlier snapshot:  the largest `<programId>__YYYY-YYYY.json` whose end-year
 *                         is <= the requested end-year
 *   3. current file:      <programsDir>/<school>/<programId>.json
 *   4. not_found
 *
 * @param programsDir override for testing; defaults to <repo>/data/programs/
 * @param logger      optional logger for fallback events; defaults to console.warn
 */
export function resolveProgramFile(
    school: string,
    programId: string,
    catalogYear: string,
    opts?: { programsDir?: string; logger?: ResolveLogger },
): ResolveResult {
    if (!CATALOG_YEAR_RE.test(catalogYear)) {
        throw new Error(
            `resolveProgramFile: invalid catalogYear "${catalogYear}". Expected "YYYY-YYYY".`,
        );
    }
    const programsDir = opts?.programsDir ?? PROGRAMS_DIR;
    const logger = opts?.logger ?? defaultLogger;
    const schoolDir = join(programsDir, school);

    if (!existsSync(schoolDir)) {
        logger({
            kind: "catalog_year_not_found",
            programId,
            school,
            requested: catalogYear,
        });
        return { kind: "not_found", programId, school, requested: catalogYear };
    }

    // 1. Exact snapshot
    const exactPath = join(schoolDir, `${programId}__${catalogYear}.json`);
    if (existsSync(exactPath)) {
        return { kind: "exact", path: exactPath, catalogYear };
    }

    // 2. Earlier snapshot — scan directory for snapshot files of this programId
    const requestedEndYear = Number(catalogYear.split("-")[1]);
    const candidates: { path: string; catalogYear: string; endYear: number }[] = [];
    let entries: string[] = [];
    try {
        entries = readdirSync(schoolDir);
    } catch {
        entries = [];
    }
    for (const entry of entries) {
        if (!entry.startsWith(`${programId}__`)) continue;
        const m = entry.match(SNAPSHOT_RE);
        if (!m) continue;
        const startY = Number(m[1]);
        const endY = Number(m[2]);
        if (endY !== startY + 1) continue; // malformed
        if (endY > requestedEndYear) continue; // not earlier-or-equal
        candidates.push({
            path: join(schoolDir, entry),
            catalogYear: `${m[1]}-${m[2]}`,
            endYear: endY,
        });
    }
    candidates.sort((a, b) => b.endYear - a.endYear);
    if (candidates.length > 0) {
        const top = candidates[0]!;
        logger({
            kind: "catalog_year_fallback",
            programId,
            school,
            requested: catalogYear,
            chosenPath: top.path,
            chosenCatalogYear: top.catalogYear,
        });
        return {
            kind: "earlier_snapshot",
            path: top.path,
            catalogYear: top.catalogYear,
            requested: catalogYear,
        };
    }

    // 3. Current file (no year suffix)
    const currentPath = join(schoolDir, `${programId}.json`);
    if (existsSync(currentPath)) {
        logger({
            kind: "catalog_year_fallback",
            programId,
            school,
            requested: catalogYear,
            chosenPath: currentPath,
        });
        return { kind: "current_fallback", path: currentPath, requested: catalogYear };
    }

    // 4. Not found
    logger({
        kind: "catalog_year_not_found",
        programId,
        school,
        requested: catalogYear,
    });
    return { kind: "not_found", programId, school, requested: catalogYear };
}

function defaultLogger(event: Parameters<ResolveLogger>[0]): void {
    // Phase 0 default: stderr line. Phase 1+ wires fallback_log.jsonl.
    // eslint-disable-next-line no-console
    console.warn("[catalog_year]", JSON.stringify(event));
}

/**
 * Compute the applicable catalogYear for a student given matriculation year,
 * readmission year (G40), and a per-program declared-under year.
 *
 * Per ARCHITECTURE.md §11.0.3:
 *   - Default: matriculation
 *   - Readmitted: readmissionYear (NOT matriculation)
 *   - Major declared after matriculation: declaredUnderCatalogYear (per program)
 *
 * The per-program override wins if present.
 */
export function applicableCatalogYear(input: {
    matriculationCatalogYear: string;
    readmissionCatalogYear?: string | null;
    declaredUnderCatalogYear?: string | null;
}): string {
    if (input.declaredUnderCatalogYear) return input.declaredUnderCatalogYear;
    if (input.readmissionCatalogYear) return input.readmissionCatalogYear;
    return input.matriculationCatalogYear;
}
