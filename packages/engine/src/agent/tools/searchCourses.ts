// ============================================================
// search_courses (Phase 7-A P-3 / §7.1)
// ============================================================
// Searches the static course catalog by keyword (title + courseId
// substring match, case-insensitive). Used by the agent for
// elective discovery and topic-based course recommendations
// ("find courses about machine learning").
//
// Phase 7-A scope: keyword search over the bundled
// `course_catalog_full.json`. Embedding-based semantic search
// (the legacy `semanticSearch.ts` was deleted in Phase 6.5 P-2)
// is a Phase 7-B follow-up — gated on the production embedder
// swap (LocalHashEmbedder → OpenAI text-embedding-3-small).
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";

interface CatalogCourse {
    courseId: string;
    title: string;
    description?: string;
    credits?: number;
    prereqs?: string[];
}

export type CourseSearchFn = (query: string, opts?: { departmentPrefix?: string; limit?: number }) => Promise<CatalogCourse[]>;

export const searchCoursesTool = buildTool({
    name: "search_courses",
    description:
        "Searches the NYU course catalog by keyword. Matches against " +
        "course title and ID (case-insensitive substring). Optionally " +
        "filters by department prefix (e.g., 'CSCI-UA' for CS courses). " +
        "Returns up to 20 matches. Use for elective discovery or topic " +
        "queries ('find courses about machine learning').",
    inputSchema: z.object({
        query: z.string().min(2).describe("Keyword to search for in course titles + ids."),
        departmentPrefix: z.string().optional().describe("e.g., 'CSCI-UA' to limit to CS"),
        limit: z.number().int().min(1).max(50).optional(),
    }),
    isReadOnly: true,
    maxResultChars: 2500,
    async validateInput(_input, _ctx) {
        return { ok: true };
    },
    prompt: () =>
        `Keyword search the NYU course catalog. Required input: query. ` +
        `Optional: departmentPrefix (e.g. "CSCI-UA"), limit (default 20).`,
    async call(input, { session }) {
        const sessExt = session as unknown as {
            courseCatalog?: CatalogCourse[];
            searchCoursesFn?: CourseSearchFn;
        };
        // Allow tests + production callers to inject either a fully
        // resolved catalog or a custom search function.
        const limit = input.limit ?? 20;
        if (sessExt.searchCoursesFn) {
            const matches = await sessExt.searchCoursesFn(input.query, {
                departmentPrefix: input.departmentPrefix,
                limit,
            });
            return { query: input.query, totalReturned: matches.length, matches };
        }
        const catalog = sessExt.courseCatalog ?? [];
        const q = input.query.toLowerCase();
        const dept = input.departmentPrefix?.toUpperCase();
        const matches: CatalogCourse[] = [];
        for (const c of catalog) {
            if (matches.length >= limit) break;
            if (dept && !c.courseId.toUpperCase().startsWith(dept)) continue;
            const haystack = `${c.courseId} ${c.title} ${c.description ?? ""}`.toLowerCase();
            if (haystack.includes(q)) matches.push(c);
        }
        return { query: input.query, totalReturned: matches.length, matches };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`COURSE SEARCH (query="${out.query}"; ${out.totalReturned} matches)`);
        if (out.matches.length === 0) {
            lines.push(`No courses matched. Try a broader keyword or remove department filter.`);
            return lines.join("\n");
        }
        for (const c of out.matches) {
            const credits = c.credits ? ` [${c.credits}cr]` : "";
            lines.push(`  ${c.courseId}: ${c.title}${credits}`);
        }
        return lines.join("\n");
    },
});
