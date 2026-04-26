// ============================================================
// Data Provenance Schema (ARCHITECTURE.md §11.0.1)
// ============================================================
// Every JSON file under data/schools/, data/programs/, data/transfers/,
// and data/departments/ MUST carry a top-level `_meta` object validated
// by this schema. This file defines the schema and a validator.
//
// Phase 0 deliverable. Enforcement of presence is Phase 1's dataLoader.
// ============================================================

import { z } from "zod";

// ---- catalogYear format ----
// "YYYY-YYYY" where the second year is exactly the first + 1.
// Examples: "2024-2025", "2025-2026".
const catalogYearRegex = /^(\d{4})-(\d{4})$/;

const catalogYearSchema = z
    .string()
    .regex(catalogYearRegex, {
        message: "catalogYear must be 'YYYY-YYYY' (e.g. '2025-2026')",
    })
    .refine(
        (v) => {
            const m = v.match(catalogYearRegex);
            if (!m) return false;
            const a = Number(m[1]);
            const b = Number(m[2]);
            return b === a + 1;
        },
        { message: "catalogYear second year must equal first year + 1" },
    );

// ---- ISO date (YYYY-MM-DD) ----
const isoDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, {
        message: "lastVerified must be ISO date 'YYYY-MM-DD'",
    });

// ---- sourceHash format ----
// We require a prefix indicating algorithm + ":" + hex digest.
// At Phase 0 we accept "sha256:<64 hex>" only; future algorithms can be added.
const sourceHashSchema = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/, {
        message: "sourceHash must be 'sha256:<64 lowercase hex chars>'",
    });

// ---- sourceRef sub-object ----
const sourceRefSchema = z
    .object({
        anchor: z.string().nullable().optional(),
        pdfPage: z.number().int().positive().nullable().optional(),
    })
    .strict();

// ---- _meta object ----
export const metaSchema = z
    .object({
        catalogYear: catalogYearSchema,
        sourceUrl: z.string().url({ message: "sourceUrl must be a valid URL" }),
        lastVerified: isoDateSchema,
        sourceHash: sourceHashSchema,
        extractedBy: z.enum(["manual", "llm-assisted", "scraper"]),
        verifiedBy: z.enum(["hand-review", "eval-suite", "unreviewed", "spot-check"]),
        sourceRef: sourceRefSchema.optional(),
    })
    .strict();

export type Meta = z.infer<typeof metaSchema>;

// ---- Top-level wrapper: any data file with _meta on top ----
// Files using this schema must have at minimum a `_meta` key.
export const fileWithMetaSchema = z
    .object({
        _meta: metaSchema,
    })
    .passthrough();

// ============================================================
// Validators
// ============================================================

export type ValidateResult =
    | { ok: true; meta: Meta }
    | { ok: false; errors: string[] };

/**
 * Validate the _meta block of a data file.
 * Returns { ok: true, meta } or { ok: false, errors: string[] }.
 *
 * Pure: never throws on validation failure. Throws only on runtime bugs.
 */
export function validateMeta(input: unknown): ValidateResult {
    const result = metaSchema.safeParse(input);
    if (result.success) {
        return { ok: true, meta: result.data };
    }
    return {
        ok: false,
        errors: result.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
        ),
    };
}

/**
 * Validate a full data file object that should carry a top-level `_meta`.
 * Returns { ok: true, meta } if _meta is valid; otherwise the error list.
 * Does NOT validate the rest of the file's body — that is each schema's job.
 */
export function validateFileWithMeta(input: unknown): ValidateResult {
    const result = fileWithMetaSchema.safeParse(input);
    if (result.success) {
        return { ok: true, meta: result.data._meta };
    }
    return {
        ok: false,
        errors: result.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
        ),
    };
}

// ============================================================
// Staleness check (ARCHITECTURE.md §11.0.4)
// ============================================================

export const STALENESS_DAYS = 180;

/**
 * Returns true if `lastVerified` is older than STALENESS_DAYS from `now`.
 * `now` is injectable for testing.
 */
export function isStale(meta: Meta, now: Date = new Date()): boolean {
    const verified = new Date(meta.lastVerified + "T00:00:00Z");
    if (Number.isNaN(verified.getTime())) {
        // Defensive: schema should have rejected, but fail-closed if not.
        return true;
    }
    const ageMs = now.getTime() - verified.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays > STALENESS_DAYS;
}
