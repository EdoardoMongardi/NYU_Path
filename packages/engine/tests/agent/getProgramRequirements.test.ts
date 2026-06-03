// ============================================================
// Phase B — get_program_requirements tool
// ============================================================
// Pins the whole-page program-requirements tool end to end:
//   - found path returns the FULL reassembled bulletin page + a
//     confidence band, and the summary surfaces every section
//   - not_found path refuses (no fabricated requirements) with an
//     uncertain disclaimer
//   - validateInput gates on rag + student

import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/rag/chunker.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";
import { LocalLexicalReranker } from "../../src/rag/reranker.js";
import { VectorStore } from "../../src/rag/vectorStore.js";
import { getProgramRequirementsTool } from "../../src/agent/tools/getProgramRequirements.js";
import type { ToolSession } from "../../src/agent/tool.js";

const CS_MD = `# Computer Science (BA)

## Overview
The CS BA introduces computational thinking and software design.

## Major Requirements
Complete CSCI-UA 101, CSCI-UA 102, CSCI-UA 201, and MATH-UA 121.

## Electives
Choose two advanced electives from CSCI-UA 470 or CSCI-UA 480.
`;

async function ragWith(md: string | null): Promise<ToolSession["rag"]> {
    const embedder = new LocalHashEmbedder(256);
    const store = new VectorStore(embedder);
    if (md) {
        await store.addChunks(
            chunkMarkdown(md, {
                source: "Computer Science BA",
                school: "cas",
                year: "2025-2026",
                sourcePath: "bulletin/cas/cs-ba.md",
                category: "program",
            }),
        );
    }
    return { store, embedder, reranker: new LocalLexicalReranker(), templates: [] };
}

function casStudent() {
    return {
        id: "u1",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [],
        coursesTaken: [],
    };
}

const ctx = { signal: new AbortController().signal } as const;

describe("get_program_requirements (Phase B)", () => {
    it("returns the FULL reassembled program page on a hit", async () => {
        const session: ToolSession = { student: casStudent(), rag: await ragWith(CS_MD) };
        const out = await getProgramRequirementsTool.call(
            { program: "computer science major requirements" },
            { ...ctx, session },
        );
        expect(out.kind).toBe("found");
        if (out.kind !== "found") return;

        expect(out.unit.sourcePath).toBe("bulletin/cas/cs-ba.md");
        // The WHOLE page is present, not just the best-matching fragment.
        expect(out.unit.text).toContain("CSCI-UA 101");
        expect(out.unit.text).toContain("advanced electives");
        expect(out.unit.text).toContain("computational thinking");
        expect(["high", "medium", "low"]).toContain(out.confidence);

        const summary = getProgramRequirementsTool.summarizeResult(out);
        expect(summary).toContain("PROGRAM REQUIREMENTS — FULL PAGE");
        expect(summary).toContain("Major Requirements");
        expect(summary).toContain("CSCI-UA 101");
        expect(summary).toContain(`confidence=${out.confidence}`);
    });

    it("refuses (not_found, uncertain) when nothing in scope matches", async () => {
        const session: ToolSession = { student: casStudent(), rag: await ragWith(null) };
        const out = await getProgramRequirementsTool.call(
            { program: "underwater basket weaving BFA" },
            { ...ctx, session },
        );
        expect(out.kind).toBe("not_found");
        if (out.kind !== "not_found") return;
        expect(out.confidence).toBe("uncertain");
        expect(out.disclaimers.length).toBeGreaterThan(0);

        const summary = getProgramRequirementsTool.summarizeResult(out);
        expect(summary).toContain("PROGRAM PAGE NOT FOUND");
        // It must NOT invent requirements.
        expect(summary).not.toContain("CSCI-UA");
    });

    it("validateInput rejects when the RAG corpus is missing", async () => {
        const session: ToolSession = { student: casStudent() };
        const v = await getProgramRequirementsTool.validateInput!(
            { program: "anything" },
            { ...ctx, session },
        );
        expect(v.ok).toBe(false);
    });

    it("validateInput rejects when the student profile is missing", async () => {
        const session: ToolSession = { rag: await ragWith(CS_MD) };
        const v = await getProgramRequirementsTool.validateInput!(
            { program: "anything" },
            { ...ctx, session },
        );
        expect(v.ok).toBe(false);
    });
});
