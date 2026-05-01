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
import { classifyCourseAccessibility } from "../../data/courseSuffixMap.js";

interface CatalogCourse {
    courseId: string;
    title: string;
    description?: string;
    credits?: number;
    prereqs?: string[];
}

export type CourseSearchFn = (query: string, opts?: { departmentPrefix?: string; limit?: number }) => Promise<CatalogCourse[]>;

// Phase 10 Stage 2 — suffix→school map and accessibility logic moved
// to packages/engine/src/data/courseSuffixMap.ts. Local alias kept so
// downstream call sites in this file don't need restructuring.
const classifyCourse = classifyCourseAccessibility;

export const searchCoursesTool = buildTool({
    name: "search_courses",
    description:
        "Searches the NYU course catalog by keyword. Matches against " +
        "course title and ID (case-insensitive substring). Optionally " +
        "filters by department prefix (e.g., 'CSCI-UA' for CS courses).\n\n" +
        "Use this for:\n" +
        "  • \"Find courses about [topic]\" / \"what ML courses exist?\"\n" +
        "  • \"Suggest a CS elective I haven't taken\" — pass `excludeCompleted: true`\n" +
        "  • \"What 4000-level math courses are offered?\"\n" +
        "  • Verifying a specific course exists in the catalog\n\n" +
        "PASS `excludeCompleted: true` whenever the user asks for " +
        "courses they HAVEN'T taken / could TAKE / NEW courses to consider. " +
        "When set AND the student's DPR is loaded, courses they've already " +
        "completed are filtered out of the result set.\n\n" +
        "DO NOT call this for \"plan my next semester\" — that's `plan_semester`'s " +
        "job. search_courses returns the broader catalog; plan_semester walks " +
        "the student's specific not-yet-satisfied requirements.",
    inputSchema: z.object({
        query: z.string().min(2).describe("Keyword to search for in course titles + ids."),
        departmentPrefix: z.string().optional().describe("e.g., 'CSCI-UA' to limit to CS"),
        limit: z.number().int().min(1).max(50).optional(),
        excludeCompleted: z.boolean().optional()
            .describe("When true AND the student's DPR is loaded, drops courses they have already completed (DPR type=EN or TE)."),
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

        // Phase 10 F3 — quality fix.
        // Issue: with no departmentPrefix, semantic search returns
        // results ranked purely by description similarity. For an
        // open-ended query like "ml course", the top hits are
        // graduate (CSCI-GA) / global-site (CS-UH) / cross-school
        // (BMIN-GA, ECE-GY) courses, because their descriptions
        // mention ML more densely than home-school undergraduate
        // catalog entries. Over-fetch the result pool by ~3× and
        // apply the accessibility sort across the wider pool, so a
        // home-school undergrad course can still surface even when
        // the raw similarity ranking buries it.
        const overFetch = input.departmentPrefix ? limit : Math.max(limit * 3, 30);
        let raw: CatalogCourse[];
        if (sessExt.searchCoursesFn) {
            raw = await sessExt.searchCoursesFn(input.query, {
                departmentPrefix: input.departmentPrefix,
                limit: overFetch,
            });
        } else {
            const catalog = sessExt.courseCatalog ?? [];
            const q = input.query.toLowerCase();
            const dept = input.departmentPrefix?.toUpperCase();
            raw = [];
            for (const c of catalog) {
                if (raw.length >= overFetch) break;
                if (dept && !c.courseId.toUpperCase().startsWith(dept)) continue;
                const haystack = `${c.courseId} ${c.title} ${c.description ?? ""}`.toLowerCase();
                if (haystack.includes(q)) raw.push(c);
            }
        }

        // Phase 8 A4 — when excludeCompleted is true AND the DPR is
        // loaded, drop any course the student has already finished.
        // Build a normalized completed-courseId set from the DPR's
        // courseHistory (excluding IP rows; only EN / TE / similar
        // count as "already taken").
        let completedFiltered = raw;
        let droppedAsCompleted = 0;
        if (input.excludeCompleted && session.degreeProgressReport) {
            const dpr = session.degreeProgressReport;
            const completedIds = new Set<string>();
            for (const c of dpr.courseHistory) {
                if (c.type === "IP") continue; // in-progress doesn't count as completed
                completedIds.add(`${c.subject} ${c.catalogNbr}`.trim().toUpperCase());
            }
            const before = completedFiltered.length;
            completedFiltered = completedFiltered.filter(
                (c) => !completedIds.has(c.courseId.trim().toUpperCase()),
            );
            droppedAsCompleted = before - completedFiltered.length;
        }

        // Annotate every match with school + accessibility tier so the
        // agent surfaces "this is Tandon, you'd need cross-school
        // approval" instead of pretending it's freely available.
        const homeSchool = session.student?.homeSchool;
        const annotated = completedFiltered.map((c) => ({
            ...c,
            ...classifyCourse(c.courseId, homeSchool),
        }));
        // Stable accessibility sort: home → cross_school → global_site
        // → graduate → unknown. Then trim to caller's `limit` so the
        // over-fetch pool surfaces home-school results when the raw
        // similarity ranker buried them.
        const order: Record<Accessibility, number> = { home: 0, cross_school: 1, global_site: 2, graduate: 3, unknown: 4 };
        annotated.sort((a, b) => order[a.accessibility] - order[b.accessibility]);
        const matches = annotated.slice(0, limit);

        // Phase 10 F3 — diagnostic note. When the displayed top-K
        // contains few or no home-school undergrad courses but the
        // wider pool exists, hint to the agent so it can ask the
        // student whether to broaden. This is data, not a per-case
        // rule: the same hint helps ANY query whose top-K is mostly
        // off-target.
        const homeCount = matches.filter((m) => m.accessibility === "home").length;
        const undergradCrossSchoolCount = matches.filter((m) => m.accessibility === "cross_school").length;
        const widerPoolHomeCount = annotated.filter((m) => m.accessibility === "home").length;
        const notes: string[] = [];
        if (homeSchool && homeCount === 0 && undergradCrossSchoolCount === 0 && matches.length > 0) {
            notes.push(
                `No home-school (${homeSchool}) undergraduate matches surfaced for "${input.query}". ` +
                `Top results are graduate / cross-school / global-site courses — the student likely cannot register for them. ` +
                `Either narrow the query (add a course-prefix like "CSCI-UA") or ask the student whether they want broader results.`,
            );
        } else if (homeCount === 0 && widerPoolHomeCount > 0) {
            notes.push(
                `${widerPoolHomeCount} home-school match(es) exist deeper in the result pool but ranked below ` +
                `graduate / cross-school courses. Consider passing a more specific query or departmentPrefix.`,
            );
        }

        return {
            query: input.query,
            totalReturned: matches.length,
            matches,
            homeSchool: homeSchool ?? null,
            notes,
            ...(input.excludeCompleted ? { excludedCompletedCount: droppedAsCompleted } : {}),
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        const excl = (out as { excludedCompletedCount?: number }).excludedCompletedCount;
        const exclNote = excl !== undefined && excl > 0 ? ` (${excl} hidden because already completed)` : "";
        lines.push(`COURSE SEARCH (query="${out.query}"; ${out.totalReturned} matches${exclNote}; home=${out.homeSchool ?? "?"})`);
        if (out.matches.length === 0) {
            lines.push(`No courses matched. Try a broader keyword or remove department filter.`);
            return lines.join("\n");
        }
        // Group by accessibility so the agent surfaces home-school
        // results first and clearly labels everything else.
        const byTier: Record<string, typeof out.matches> = {};
        for (const m of out.matches) {
            (byTier[m.accessibility] ??= []).push(m);
        }
        const labels: Record<Accessibility, string> = {
            home: "AT YOUR HOME SCHOOL (open enrollment for you)",
            cross_school: "CROSS-SCHOOL (likely needs approval to count toward your degree)",
            global_site: "GLOBAL SITE (only via a study-abroad term)",
            graduate: "GRADUATE (not open to undergrads except by petition)",
            unknown: "UNCLASSIFIED",
        };
        for (const tier of ["home", "cross_school", "global_site", "graduate", "unknown"] as const) {
            const ms = byTier[tier];
            if (!ms || ms.length === 0) continue;
            lines.push(`-- ${labels[tier]} --`);
            for (const c of ms) {
                const credits = c.credits ? ` [${c.credits}cr]` : "";
                lines.push(`  ${c.courseId} (${c.school}): ${c.title}${credits}`);
            }
        }
        // Phase 10 F3 — diagnostic notes. Surfaced after the result
        // list so the agent can decide whether to broaden or narrow
        // the search before quoting matches to the student.
        const notes = (out as { notes?: string[] }).notes ?? [];
        if (notes.length > 0) {
            lines.push("");
            lines.push("Notes:");
            for (const n of notes) lines.push(`  • ${n}`);
        }
        return lines.join("\n");
    },
});
