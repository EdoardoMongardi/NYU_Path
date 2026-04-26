// ============================================================
// School Config Loader (ARCHITECTURE.md §11.2 + §11.0.1)
// ============================================================
// Loads and validates `data/schools/<schoolId>.json`. Every config MUST
// carry a top-level `_meta` block validated by the Phase 0 provenance
// schema. Returns `null` for unknown schoolIds — callers should fall
// back to module-local CAS_DEFAULTS in that case (Phase 1 Step D).
//
// Path resolution: configs live at the repo root under `data/schools/`,
// not inside the engine bundle. Same convention as catalogYearLoader.
// ============================================================

import type { SchoolConfig } from "@nyupath/shared";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type Meta,
    validateFileWithMeta,
} from "../provenance/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// data/schools/ lives at the repo root. Resolve relative to this file:
// <repo>/packages/engine/src/data/ → <repo>/data/schools/
const REPO_DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");
const SCHOOLS_DIR = join(REPO_DATA_DIR, "schools");

export type SchoolConfigLoadResult =
    | { ok: true; config: SchoolConfig; meta: Meta; path: string }
    | { ok: false; reason: "not_found"; schoolId: string; path: string }
    | { ok: false; reason: "invalid_meta"; schoolId: string; path: string; errors: string[] }
    | { ok: false; reason: "parse_error"; schoolId: string; path: string; error: string };

/**
 * Load a school config by id. Returns a discriminated union so callers
 * can distinguish missing files from malformed metadata.
 *
 * @param schoolId   "cas", "stern", "tandon", etc.
 * @param schoolsDir override for testing; defaults to <repo>/data/schools/
 */
export function loadSchoolConfigStrict(
    schoolId: string,
    opts?: { schoolsDir?: string },
): SchoolConfigLoadResult {
    const schoolsDir = opts?.schoolsDir ?? SCHOOLS_DIR;
    const path = join(schoolsDir, `${schoolId}.json`);

    if (!existsSync(path)) {
        return { ok: false, reason: "not_found", schoolId, path };
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf-8");
    } catch (err) {
        return {
            ok: false,
            reason: "parse_error",
            schoolId,
            path,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return {
            ok: false,
            reason: "parse_error",
            schoolId,
            path,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const metaResult = validateFileWithMeta(parsed);
    if (!metaResult.ok) {
        return {
            ok: false,
            reason: "invalid_meta",
            schoolId,
            path,
            errors: metaResult.errors,
        };
    }

    // Strip _meta from the body before returning the SchoolConfig.
    // The body shape is enforced by the SchoolConfig TypeScript type at
    // call sites — we don't validate it here at v1.0.
    const { _meta: _meta, ...body } = parsed as { _meta: unknown } & Record<string, unknown>;
    return {
        ok: true,
        config: body as unknown as SchoolConfig,
        meta: metaResult.meta,
        path,
    };
}

/**
 * Convenience wrapper: returns the SchoolConfig or `null` for any failure.
 *
 * Matches the shape that engine modules need under the "CAS fallback"
 * pattern — `loadSchoolConfig(schoolId) ?? null` and then fall back to
 * each module's CAS_DEFAULTS. Logs a warning to stderr on failure so
 * misconfigurations do not pass silently.
 */
export function loadSchoolConfig(
    schoolId: string,
    opts?: { schoolsDir?: string },
): SchoolConfig | null {
    const result = loadSchoolConfigStrict(schoolId, opts);
    if (result.ok) return result.config;

    // eslint-disable-next-line no-console
    console.warn(
        "[school_config]",
        JSON.stringify({
            kind: "school_config_load_failed",
            schoolId,
            reason: result.reason,
            ...(result.reason === "invalid_meta" ? { errors: result.errors } : {}),
            ...(result.reason === "parse_error" ? { error: result.error } : {}),
        }),
    );
    return null;
}
