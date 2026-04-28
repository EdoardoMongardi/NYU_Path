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

// ---- Phase 7-E follow-up: cross-school accessibility annotation ----
// NYU course-id suffix → (school name, undergrad-availability tier).
// Tier semantics (relative to the student's homeSchool):
//   - "home"          — same school, freely accessible
//   - "cross_school"  — different undergrad school in NY; needs cross-
//                       school enrollment per the home school's policy
//   - "global_site"   — Abu Dhabi or Shanghai courses; only for study-
//                       abroad terms
//   - "graduate"      — graduate/professional course; generally not
//                       open to undergrads
//   - "unknown"       — suffix we don't have a rule for

interface SchoolMeta {
    school: string;
    undergrad: boolean;
    /** When undergrad=false, the course is graduate. */
    globalSite: "abudhabi" | "shanghai" | null;
}

const SUFFIX_META: Record<string, SchoolMeta> = {
    "UA":  { school: "CAS",                          undergrad: true,  globalSite: null },
    "UB":  { school: "Stern (undergrad)",            undergrad: true,  globalSite: null },
    "UY":  { school: "Tandon (undergrad)",           undergrad: true,  globalSite: null },
    "UE":  { school: "Steinhardt (undergrad)",       undergrad: true,  globalSite: null },
    "UF":  { school: "Tisch (undergrad)",            undergrad: true,  globalSite: null },
    "UT":  { school: "Tisch (undergrad, alt)",       undergrad: true,  globalSite: null },
    "UN":  { school: "Gallatin",                     undergrad: true,  globalSite: null },
    "UP":  { school: "Liberal Studies",              undergrad: true,  globalSite: null },
    "UH":  { school: "NYU Abu Dhabi",                undergrad: true,  globalSite: "abudhabi" },
    "SHU": { school: "NYU Shanghai",                 undergrad: true,  globalSite: "shanghai" },
    "GA":  { school: "GSAS (graduate)",              undergrad: false, globalSite: null },
    "GY":  { school: "Tandon (graduate)",            undergrad: false, globalSite: null },
    "GU":  { school: "Steinhardt (graduate)",        undergrad: false, globalSite: null },
    "GH":  { school: "Steinhardt (graduate)",        undergrad: false, globalSite: null },
    "GX":  { school: "Cross-school (graduate)",      undergrad: false, globalSite: null },
    "GB":  { school: "Stern (graduate)",             undergrad: false, globalSite: null },
    "GS":  { school: "SPS (graduate)",               undergrad: false, globalSite: null },
    "MD":  { school: "Medical School",               undergrad: false, globalSite: null },
    "MS":  { school: "Medical School",               undergrad: false, globalSite: null },
    "DN":  { school: "Dental",                       undergrad: false, globalSite: null },
    "BMSC":{ school: "Biomedical Sciences (graduate)", undergrad: false, globalSite: null },
    "BMIN":{ school: "Biomedical Informatics (grad)",  undergrad: false, globalSite: null },
    "LW":  { school: "Law",                          undergrad: false, globalSite: null },
};

const HOME_SCHOOL_TO_SUFFIX: Record<string, string> = {
    "cas":        "UA",
    "stern":      "UB",
    "tandon":     "UY",
    "steinhardt": "UE",
    "tisch":      "UF",
    "gallatin":   "UN",
    "ls":         "UP",
};

type Accessibility = "home" | "cross_school" | "global_site" | "graduate" | "unknown";

function classifyCourse(courseId: string, homeSchool: string | undefined):
    { school: string; accessibility: Accessibility; note?: string } {
    // Extract the alpha suffix after the dash. NYU ids look like
    // "CSCI-UA 102", "CS-UH 2220", "BMIN-GA 1004", "ENGR-UH 3332".
    const m = courseId.match(/-([A-Z]+)\b/);
    if (!m) return { school: "Unknown", accessibility: "unknown" };
    const suffix = m[1]!;
    const meta = SUFFIX_META[suffix];
    if (!meta) {
        // Try the SUBJECT prefix (some ids don't follow the dash-suffix
        // convention — e.g., "BMSC-GA"). Fall back to last 2-letter token.
        const fallback = SUFFIX_META[suffix.slice(-2)];
        if (!fallback) return { school: `Subject "${suffix}"`, accessibility: "unknown" };
        return classifyFromMeta(fallback, homeSchool);
    }
    return classifyFromMeta(meta, homeSchool);
}

function classifyFromMeta(meta: SchoolMeta, homeSchool: string | undefined):
    { school: string; accessibility: Accessibility; note?: string } {
    if (!meta.undergrad) {
        return { school: meta.school, accessibility: "graduate", note: "graduate course — not open to undergrads except by petition" };
    }
    if (meta.globalSite) {
        return {
            school: meta.school,
            accessibility: "global_site",
            note: `${meta.school} site — only available during a study-abroad term`,
        };
    }
    const homeSuffix = homeSchool ? HOME_SCHOOL_TO_SUFFIX[homeSchool.toLowerCase()] : undefined;
    const studentSchool = homeSuffix && SUFFIX_META[homeSuffix]?.school;
    if (homeSuffix && studentSchool && meta.school === studentSchool) {
        return { school: meta.school, accessibility: "home" };
    }
    return {
        school: meta.school,
        accessibility: "cross_school",
        note: `cross-school course — your home school may require approval to count it toward your degree`,
    };
}

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
        let raw: CatalogCourse[];
        if (sessExt.searchCoursesFn) {
            raw = await sessExt.searchCoursesFn(input.query, {
                departmentPrefix: input.departmentPrefix,
                limit,
            });
        } else {
            const catalog = sessExt.courseCatalog ?? [];
            const q = input.query.toLowerCase();
            const dept = input.departmentPrefix?.toUpperCase();
            raw = [];
            for (const c of catalog) {
                if (raw.length >= limit) break;
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
        const matches = completedFiltered.map((c) => ({
            ...c,
            ...classifyCourse(c.courseId, homeSchool),
        }));
        // Order: home → cross_school → global_site → graduate → unknown.
        const order: Record<Accessibility, number> = { home: 0, cross_school: 1, global_site: 2, graduate: 3, unknown: 4 };
        matches.sort((a, b) => order[a.accessibility] - order[b.accessibility]);
        return {
            query: input.query,
            totalReturned: matches.length,
            matches,
            homeSchool: homeSchool ?? null,
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
        return lines.join("\n");
    },
});
