// ============================================================
// search_availability — FOSE-backed live section query
// (ARCHITECTURE.md §11.7.3, §11.7.6)
// ============================================================
// Wraps the existing FOSE client (api/nyuClassSearch.ts) into a tool
// the Phase 5 agent loop can call. Phase 0 deliverable: thin stub —
// no caching, no agent loop integration. Phase 1+ adds the cache.
// ============================================================

import { z } from "zod";
import {
    type FoseSearchResult,
    generateTermCode,
    searchCourses,
} from "../api/nyuClassSearch.js";
import { buildTool, type ValidationResult } from "./types.js";

// ---- Term input ----
// The agent may pass either a raw FOSE term code ("1258") or a
// {year, term} pair. The tool resolves internally.
const termCodeRegex = /^1\d{3}$/;

const termInputSchema = z.union([
    z.object({ termCode: z.string().regex(termCodeRegex) }),
    z.object({
        year: z.number().int().min(2000).max(2100),
        term: z.enum(["spring", "summer", "fall"]),
    }),
]);

const inputSchema = z.object({
    courseCode: z
        .string()
        .min(1)
        .describe('Course code, e.g. "CSCI-UA 101"'),
    term: termInputSchema,
});

export type SearchAvailabilityInput = z.infer<typeof inputSchema>;

export interface SectionView {
    crn: string;
    code: string;
    title: string;
    /**
     * Raw FOSE enrollment status code, passed through verbatim.
     * Observed values include "O" (open), "W" (waitlist), "C" (closed),
     * and "A" (seen in live FOSE responses; likely "available", but the
     * full set is undocumented by FOSE/Leepfrog). Treat as an opaque
     * string at the type level — do not assume the set is closed.
     */
    status: string;
    instructor?: string;
    hours?: string;
    credits?: string;
}

export interface SearchAvailabilityOutput {
    termCode: string;
    courseCode: string;
    sections: SectionView[];
    fetchedAt: string;
    /** True if FOSE returned zero matching sections — distinct from network failure. */
    offeredThisTerm: boolean;
}

function resolveTermCode(term: SearchAvailabilityInput["term"]): string {
    if ("termCode" in term) return term.termCode;
    return generateTermCode(term.year, term.term);
}

function toSectionView(r: FoseSearchResult): SectionView {
    return {
        crn: r.crn,
        code: r.code,
        title: r.title,
        status: r.stat,
        instructor: r.instr,
        hours: r.hours,
        credits: r.credits,
    };
}

export const searchAvailability = buildTool<
    SearchAvailabilityInput,
    SearchAvailabilityOutput
>({
    name: "search_availability",
    description:
        "Look up live section availability for a single course in a specific term. " +
        "Returns CRN, status (O/W/C), instructor, meeting times. " +
        "Use this when the student asks whether a course is offered or has open seats. " +
        "Do NOT use for catalog metadata (credits, prereqs) — that comes from the static catalog.",
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultChars: 2500,
    validateInput(input): ValidationResult {
        const r = inputSchema.safeParse(input);
        if (!r.success) {
            return {
                result: false,
                message: r.error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; "),
            };
        }
        return { result: true };
    },
    async call(input, ctx) {
        const termCode = resolveTermCode(input.term);
        if (ctx.signal?.aborted) {
            throw new Error("aborted");
        }
        // searchCourses takes a keyword. To narrow to a single course code,
        // we pass the courseCode itself; FOSE returns matching sections.
        const results = await searchCourses(termCode, input.courseCode);
        const sections = results
            .filter((r) => r.code === input.courseCode)
            .map(toSectionView);
        return {
            termCode,
            courseCode: input.courseCode,
            sections,
            fetchedAt: new Date().toISOString(),
            offeredThisTerm: sections.length > 0,
        };
    },
});
