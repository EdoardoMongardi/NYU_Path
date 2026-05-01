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
    generateTermCode,
    type FoseSearchResult,
} from "../../api/nyuClassSearch.js";

export type SearchCoursesFn = (termCode: string, keyword: string) => Promise<FoseSearchResult[]>;

const TERM_CODE_RE = /^\d{4}$/;

export const searchAvailabilityTool = buildTool({
    name: "search_availability",
    description:
        "Looks up whether a course is offered in a given NYU term via the " +
        "FOSE class-search API. Use this BEFORE recommending a specific " +
        "section.\n\n" +
        "INPUT (Phase 9 Stage 5 — two equivalent forms):\n" +
        "  Preferred: pass `year` (4-digit, e.g. 2026) AND `term` " +
        "(\"spring\" | \"summer\" | \"fall\"). The tool computes the FOSE " +
        "term code internally so the model can't typo it.\n" +
        "  Fallback: pass `termCode` (4-digit FOSE code) directly. NYU's " +
        "encoding is `1{lastTwoDigitsOfYear}{4=spring,6=summer,8=fall}` — " +
        "Fall 2026 = 1268, Spring 2027 = 1274. Most models get this wrong " +
        "from training data; PREFER the year+term form.\n\n" +
        "ALSO required: `keyword` (course code prefix like \"CSCI-UA\" " +
        "or full code \"CSCI-UA 101\"). Returns up to 25 sections with " +
        "open/waitlist/closed status, instructors, credits, and meeting " +
        "times.",
    inputSchema: z.object({
        // Phase 9 Stage 5 — accept both forms; resolve to a single code in call().
        termCode: z.string().regex(TERM_CODE_RE, "termCode must be a 4-digit FOSE term code").optional(),
        year: z.number().int().min(2000).max(2099).optional(),
        term: z.enum(["spring", "summer", "fall"]).optional(),
        keyword: z.string().min(2),
    }),
    isReadOnly: true,
    maxResultChars: 2500,
    async validateInput(input, _ctx) {
        const hasCode = typeof input.termCode === "string";
        const hasYearTerm = typeof input.year === "number" && typeof input.term === "string";
        if (!hasCode && !hasYearTerm) {
            return {
                ok: false,
                userMessage:
                    "Pass either `termCode` (4-digit) OR both `year` (e.g. 2026) and `term` (\"spring\"/\"summer\"/\"fall\"). " +
                    "The year+term form is preferred — the tool computes the FOSE code so you can't typo it.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Look up FOSE class-search availability for a course in a given term. ` +
        `Pass year+term (preferred) or termCode. ALSO required: keyword (course code prefix or full code).`,
    async call(input, { session }) {
        // Allow tests to inject a stub via session. Production runs the
        // live FOSE client by default.
        const sessionExt = session as unknown as { searchAvailabilityFn?: SearchCoursesFn };
        const fn = sessionExt.searchAvailabilityFn ?? defaultSearchCourses;
        // Resolve termCode from year+term when provided. Authoritative
        // mapping lives in api/nyuClassSearch.ts:generateTermCode so a
        // single source of truth governs the encoding.
        const resolvedTermCode = input.termCode
            ?? generateTermCode(input.year!, input.term!);
        const results = await fn(resolvedTermCode, input.keyword);
        const limited = results.slice(0, 25);
        return {
            termCode: resolvedTermCode,
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
