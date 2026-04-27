// ============================================================
// Phase 6 WS7c — template corpus regression tests
// ============================================================
// Pins: every JSON in data/policy_templates/ loads cleanly through
// loadPolicyTemplates (passes _meta + body validators), every
// template fires on at least one of its own triggerQueries through
// the matcher (catches typos in triggerQueries[]), and the corpus
// hits the Phase-6 floor of 7 templates.
// ============================================================

import { describe, expect, it } from "vitest";
import { loadPolicyTemplates } from "../../src/rag/policyTemplateLoader.js";
import { matchTemplate } from "../../src/rag/policyTemplate.js";

const TODAY = new Date("2026-04-26T00:00:00Z");

describe("template corpus (Phase 6 WS7c)", () => {
    const r = loadPolicyTemplates();

    it("loads every template without _meta/body validation errors", () => {
        expect(r.skipped).toEqual([]);
        // Phase 7-A reviewer-P3 follow-up: corpus expanded 15 → 17
        // (target: 20-30 per §5.5; remaining gap is content-authoring
        // against real cohort A queries).
        expect(r.templates.length).toBeGreaterThanOrEqual(17);
    });

    it("includes the Phase 5 + Phase 6 templates by id", () => {
        const ids = r.templates.map((t) => t.id).sort();
        // Phase 5 (3): cas_pf_major, cas_credit_overload, stern_pf_major
        expect(ids).toContain("cas_pf_major");
        expect(ids).toContain("cas_credit_overload");
        expect(ids).toContain("stern_pf_major");
        // Phase 6 WS7c additions (3 new, all bulletin-grounded):
        expect(ids).toContain("cas_withdrawal");
        expect(ids).toContain("cas_pf_career_cap");
        expect(ids).toContain("cas_to_stern_transfer");
        // Note: f1_credit_floor was authored but removed pending a
        // scraped OGS/NYU full-time-status bulletin file — without
        // one the drift guard can't verify the template's quotes.
        // Reinstate once the bulletin file lands.
    });

    it("every template fires on its own first triggerQuery for a same-school student", () => {
        for (const t of r.templates) {
            const home = t.school === "all" ? "cas" : t.school;
            const firstTrigger = t.triggerQueries[0]!;
            const m = matchTemplate(firstTrigger, [t], home, { now: TODAY });
            expect(m, `template ${t.id} did not match its own first trigger "${firstTrigger}"`).not.toBeNull();
            expect(m?.template.id).toBe(t.id);
        }
    });

    it("cas_pf_major wins over cas_pf_career_cap on major-adjacent queries (P2 nit fix)", () => {
        // Reviewer P2: a query mentioning P/F + major should route
        // to cas_pf_major, not the career-cap template. The career-cap
        // triggers were tightened to require "career" / "cap" / "election"
        // tokens so they only fire on cap-specific questions.
        const m = matchTemplate(
            "how many P/F credits can I take in my major",
            r.templates,
            "cas",
            { now: TODAY },
        );
        expect(m?.template.id).toBe("cas_pf_major");
    });

    it("cas_pf_career_cap fires unambiguously on cap-specific queries", () => {
        const m = matchTemplate(
            "what's the P/F career cap?",
            r.templates,
            "cas",
            { now: TODAY },
        );
        expect(m?.template.id).toBe("cas_pf_career_cap");
    });

    it("every template body cites a bulletin source (matches the architecture rule §2.1)", () => {
        for (const t of r.templates) {
            // The body should reference the source explicitly OR the
            // bulletin/policy page. We check for one of: "bulletin",
            // "ARCHITECTURE.md", "OGS", "Stern", "CAS", "(line"
            // — any of these signals an explicit citation.
            const body = t.body.toLowerCase();
            const hasCitation = /bulletin|architecture|ogs|stern|cas|\(line|nyu/i.test(body);
            expect(hasCitation, `template ${t.id} body lacks an obvious citation marker`).toBe(true);
        }
    });
});
