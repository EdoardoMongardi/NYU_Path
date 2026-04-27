// ============================================================
// Phase 6 WS6 — template-matcher token-overlap regression tests
// ============================================================
// The matcher uses two passes:
//   (a) contiguous-substring match (fast path, unchanged)
//   (b) token-overlap match (Wave5 finding #2 fix)
//
// These tests pin both directions: token-overlap fires for
// non-contiguous phrasings, AND does not fire for unrelated queries
// that happen to share stop words.
// ============================================================

import { describe, expect, it } from "vitest";
import type { PolicyTemplate } from "../../src/rag/policyTemplate.js";
import { matchTemplate } from "../../src/rag/policyTemplate.js";

const TODAY = new Date("2026-04-26T00:00:00Z");

const cas_pf_major: PolicyTemplate = {
    id: "cas_pf_major",
    school: "cas",
    source: "test",
    lastVerified: "2026-04-26",
    triggerQueries: ["p/f major", "pass fail major", "pass-fail in my major"],
    body: "test body",
};

describe("matchTemplate — substring path (unchanged)", () => {
    it("matches exact contiguous trigger as substring", () => {
        const m = matchTemplate("can i p/f major courses", [cas_pf_major], "cas", { now: TODAY });
        expect(m?.template.id).toBe("cas_pf_major");
        expect(m?.matchedTrigger).toBe("p/f major");
    });

    it("does NOT match an unrelated query", () => {
        const m = matchTemplate("what is my GPA", [cas_pf_major], "cas", { now: TODAY });
        expect(m).toBeNull();
    });
});

describe("matchTemplate — token-overlap path (Phase 6 WS6)", () => {
    it("matches non-contiguous phrasings via token overlap", () => {
        // "Can I take a major course P/F?" — trigger "p/f major"
        // tokens are non-contiguous. Substring fails; token-overlap
        // wins because both trigger tokens appear in the query.
        const m = matchTemplate(
            "Can I take a major course P/F?",
            [cas_pf_major],
            "cas",
            { now: TODAY },
        );
        expect(m?.template.id).toBe("cas_pf_major");
    });

    it("matches reversed-token query", () => {
        const m = matchTemplate("major p/f", [cas_pf_major], "cas", { now: TODAY });
        expect(m?.template.id).toBe("cas_pf_major");
    });

    it("matches a question phrased with 'pass-fail' against the 'pass-fail in my major' trigger", () => {
        const m = matchTemplate(
            "Is pass-fail allowed for my major?",
            [cas_pf_major],
            "cas",
            { now: TODAY },
        );
        expect(m?.template.id).toBe("cas_pf_major");
    });

    it("does NOT match a query that only shares stop words", () => {
        // "Can I take it?" tokenizes to nearly all stop words. No
        // trigger token "p/f" or "major" present → must not fire.
        const m = matchTemplate("Can I take it?", [cas_pf_major], "cas", { now: TODAY });
        expect(m).toBeNull();
    });

    it("does NOT match when only ONE of two trigger tokens appears", () => {
        // Trigger "p/f major" needs ≥0.66 overlap. With only "major"
        // (1/2 = 0.5 < 0.66), should not fire.
        const m = matchTemplate(
            "what does my major require",
            [cas_pf_major],
            "cas",
            { now: TODAY },
        );
        expect(m).toBeNull();
    });

    it("respects context-pronoun guard (matcher refuses 'can i do that' queries)", () => {
        // §5.5 step 2 — context-pronoun guard predates the WS6
        // upgrade; ensure WS6 didn't break it.
        const m = matchTemplate("can i do that with p/f major", [cas_pf_major], "cas", { now: TODAY });
        expect(m).toBeNull();
    });
});

describe("matchTemplate — cross-school + freshness gates still active", () => {
    it("does NOT fire for a different home school", () => {
        const m = matchTemplate("can i p/f major courses", [cas_pf_major], "stern", { now: TODAY });
        expect(m).toBeNull();
    });

    it("does NOT fire for a stale template", () => {
        const stale: PolicyTemplate = {
            ...cas_pf_major,
            lastVerified: "2024-01-01", // > 365 days from TODAY
        };
        const m = matchTemplate("can i p/f major courses", [stale], "cas", { now: TODAY });
        expect(m).toBeNull();
    });
});
