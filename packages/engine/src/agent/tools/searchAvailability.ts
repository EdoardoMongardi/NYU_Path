// ============================================================
// search_availability (Phase 6 WS7b — §7.1 / §11.7.3)
// ============================================================
// Wraps the FOSE NYU Class Search client. The architecture lists
// `search_availability` as the canonical "is this course offered next
// term?" tool — agents must call it BEFORE recommending a specific
// section in a plan (§Appendix A rule #2: "NEVER guess course
// availability").
//
// To stay testable without hitting the live FOSE API, the tool accepts
// an optional `searchFn` injection point on the session. Production
// uses the default (`searchCourses` from `api/nyuClassSearch.ts`); unit
// tests inject a stub.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import {
    searchCourses as defaultSearchCourses,
    type FoseSearchResult,
} from "../../api/nyuClassSearch.js";

export type SearchCoursesFn = (termCode: string, keyword: string) => Promise<FoseSearchResult[]>;

const TERM_CODE_RE = /^\d{4}$/;

export const searchAvailabilityTool = buildTool({
    name: "search_availability",
    description:
        "Looks up whether a course is offered in a given NYU term via the " +
        "FOSE class-search API. Use this BEFORE recommending a specific " +
        "section. Input: termCode (4-digit FOSE code, e.g. \"1254\" for " +
        "Spring 2025) and keyword (course code prefix like \"CSCI-UA\" " +
        "or full code \"CSCI-UA 101\"). Returns up to 25 sections with " +
        "open/waitlist/closed status, instructors, credits, and meeting " +
        "times.",
    inputSchema: z.object({
        termCode: z.string().regex(TERM_CODE_RE, "termCode must be a 4-digit FOSE term code"),
        keyword: z.string().min(2),
    }),
    isReadOnly: true,
    maxResultChars: 2500,
    async validateInput(_input, _ctx) {
        return { ok: true };
    },
    prompt: () =>
        `Look up FOSE class-search availability for a course in a given term. ` +
        `Required input: termCode (4-digit), keyword (course code prefix or ` +
        `full code). Returns sections with enrollment status.`,
    async call(input, { session }) {
        // Allow tests to inject a stub via session. Production runs the
        // live FOSE client by default.
        const sessionExt = session as unknown as { searchAvailabilityFn?: SearchCoursesFn };
        const fn = sessionExt.searchAvailabilityFn ?? defaultSearchCourses;
        const results = await fn(input.termCode, input.keyword);
        const limited = results.slice(0, 25);
        return {
            termCode: input.termCode,
            keyword: input.keyword,
            totalReturned: limited.length,
            totalAvailable: results.length,
            sections: limited.map((r) => ({
                code: r.code,
                title: r.title,
                crn: r.crn,
                stat: r.stat,
                statLabel: statLabel(r.stat),
                instr: r.instr,
                credits: r.credits,
                hours: r.hours,
            })),
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`FOSE availability (term=${out.termCode}, keyword="${out.keyword}")`);
        lines.push(`Returned ${out.totalReturned} of ${out.totalAvailable} matching sections.`);
        if (out.sections.length === 0) {
            lines.push(`No sections found. The course may not be offered this term, or the keyword may be too narrow.`);
            return lines.join("\n");
        }
        const groups = new Map<string, typeof out.sections>();
        for (const s of out.sections) {
            const existing = groups.get(s.code) ?? [];
            existing.push(s);
            groups.set(s.code, existing);
        }
        for (const [code, sections] of groups) {
            const open = sections.filter((s) => s.stat === "O").length;
            const wl = sections.filter((s) => s.stat === "W").length;
            const closed = sections.filter((s) => s.stat === "C").length;
            lines.push(`  ${code}: ${sections.length} sections (${open} open, ${wl} waitlist, ${closed} closed)`);
            // Up to 2 representative sections per course
            for (const s of sections.slice(0, 2)) {
                const instr = s.instr ? ` — ${s.instr}` : "";
                const credits = s.credits ? ` [${s.credits}cr]` : "";
                lines.push(`    [${s.statLabel}] CRN ${s.crn}${credits}${instr}`);
            }
        }
        return lines.join("\n");
    },
});

function statLabel(stat: string): string {
    if (stat === "O") return "open";
    if (stat === "W") return "waitlist";
    if (stat === "C") return "closed";
    return stat;
}
