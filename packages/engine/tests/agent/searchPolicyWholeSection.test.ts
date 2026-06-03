// ============================================================
// Phase B — search_policy whole-section expansion
// ============================================================
// When the top RAG hit is one fragment of a section that the chunker
// split across several ~500-token windows, search_policy now reassembles
// and renders the TOP hit's FULL section. This pins that the complete
// section reaches the agent — including text far past the single
// fragment's truncation window.

import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/rag/chunker.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";
import { LocalLexicalReranker } from "../../src/rag/reranker.js";
import { VectorStore } from "../../src/rag/vectorStore.js";
import { searchPolicyTool } from "../../src/agent/tools/searchPolicy.js";
import type { ToolSession } from "../../src/agent/tool.js";

// A Pass/Fail section big enough (>500 whitespace tokens) that the
// chunker cuts it into two overlapping pieces. The query tokens sit at
// the very START (so the first piece wins the rerank); ALPHA marks the
// start, OMEGA sits ~6000 chars later — well past the 1400-char fragment
// cap — so only the reassembled FULL SECTION can surface both.
const HEAD = "Students may exercise the pass fail option deadline withdrawal eligibility under these rules. UNIQUEMARKERALPHA.";
const FILLER = Array.from({ length: 520 }, (_, i) => `policyword${i}`).join(" ");
const TAIL = "UNIQUEMARKEROMEGA the pass fail deadline falls in the ninth week of the term.";
const POLICY_MD = `# Pass/Fail Policy

## Pass/Fail Option
${HEAD} ${FILLER} ${TAIL}
`;

function casStudent() {
    return {
        id: "u1",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [],
        coursesTaken: [],
    };
}

async function sessionWithPolicy(): Promise<ToolSession> {
    const embedder = new LocalHashEmbedder(256);
    const store = new VectorStore(embedder);
    await store.addChunks(
        chunkMarkdown(POLICY_MD, {
            source: "CAS Pass/Fail Policy",
            school: "cas",
            year: "2025-2026",
            sourcePath: "bulletin/cas/passfail.md",
            category: "academic_policy",
        }),
    );
    return {
        student: casStudent(),
        rag: { store, embedder, reranker: new LocalLexicalReranker(), templates: [] },
    };
}

const ctx = { signal: new AbortController().signal } as const;

describe("search_policy — whole-section expansion (Phase B)", () => {
    it("reassembles and renders the TOP hit's full section", async () => {
        const session = await sessionWithPolicy();
        const out = await searchPolicyTool.call(
            { query: "pass fail option deadline withdrawal eligibility" },
            { ...ctx, session },
        );

        // A RAG hit (not escalate) so the section can be expanded.
        expect(out.kind).toBe("rag");
        const ws = (out as { wholeSection?: { sourcePath: string } | null }).wholeSection;
        expect(ws?.sourcePath).toBe("bulletin/cas/passfail.md");

        const summary = searchPolicyTool.summarizeResult(out);
        expect(summary).toContain("FULL SECTION (top hit, reassembled");
        // Both the start AND the far end of the section are present —
        // the latter lives past the single fragment's 1400-char cap, so
        // only the reassembled section could have surfaced it.
        expect(summary).toContain("UNIQUEMARKERALPHA");
        expect(summary).toContain("UNIQUEMARKEROMEGA");
    });

    it("no FULL SECTION block when nothing in scope matches (escalate)", async () => {
        // Empty store → escalate path, no hits, no expansion.
        const embedder = new LocalHashEmbedder(256);
        const session: ToolSession = {
            student: casStudent(),
            rag: { store: new VectorStore(embedder), embedder, reranker: new LocalLexicalReranker(), templates: [] },
        };
        const out = await searchPolicyTool.call({ query: "anything at all" }, { ...ctx, session });
        const summary = searchPolicyTool.summarizeResult(out);
        expect(summary).not.toContain("FULL SECTION");
    });
});
