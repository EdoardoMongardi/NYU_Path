// ============================================================
// Phase B — section-complete retrieval (rag/sectionRetrieval.ts)
// ============================================================
// Pins the whole-PAGE / whole-SECTION reassembly + the source-locate
// step that `get_program_requirements` is built on:
//   - reassembleSource stitches every chunk of a source back into one
//     ordered document (headings + bodies, in file order)
//   - reassembleSection returns just one section
//   - the splitter's inter-piece overlap is removed at the seam
//   - locateBestSource honors the default-hard school scope and the
//     soft category preference

import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../../src/rag/chunker.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";
import { LocalLexicalReranker } from "../../src/rag/reranker.js";
import { VectorStore } from "../../src/rag/vectorStore.js";
import {
    locateBestSource,
    reassembleSection,
    reassembleSource,
} from "../../src/rag/sectionRetrieval.js";

const CS_MD = `# Computer Science (BA)

## Overview
The CS BA introduces computational thinking and software design.

## Major Requirements
Complete CSCI-UA 101, CSCI-UA 102, CSCI-UA 201, and MATH-UA 121.

## Electives
Choose two advanced electives from CSCI-UA 470 or CSCI-UA 480.
`;

const ECON_MD = `# Economics (BA)

## Overview
The Economics BA covers micro and macro theory.

## Major Requirements
Complete ECON-UA 1, ECON-UA 2, ECON-UA 11, and ECON-UA 12.
`;

const STERN_MD = `# Business (BS)

## Major Requirements
Complete the Stern business core sequence.
`;

function csChunks() {
    return chunkMarkdown(CS_MD, {
        source: "Computer Science BA",
        school: "cas",
        year: "2025-2026",
        sourcePath: "bulletin/cas/cs-ba.md",
        category: "program",
    });
}
function econChunks() {
    return chunkMarkdown(ECON_MD, {
        source: "Economics BA",
        school: "cas",
        year: "2025-2026",
        sourcePath: "bulletin/cas/econ-ba.md",
        category: "program",
    });
}
function sternChunks() {
    return chunkMarkdown(STERN_MD, {
        source: "Stern Business BS",
        school: "stern",
        year: "2025-2026",
        sourcePath: "bulletin/stern/business-bs.md",
        category: "program",
    });
}

async function storeWith(...chunkLists: ReturnType<typeof csChunks>[]) {
    const store = new VectorStore(new LocalHashEmbedder(256));
    for (const cl of chunkLists) await store.addChunks(cl);
    return store;
}

describe("reassembleSource (Phase B)", () => {
    it("stitches every chunk of a source into one ordered page", async () => {
        const store = await storeWith(csChunks(), econChunks());
        const unit = reassembleSource(store, "bulletin/cas/cs-ba.md");
        expect(unit).not.toBeNull();
        if (!unit) return;

        expect(unit.source).toBe("Computer Science BA");
        expect(unit.school).toBe("cas");
        expect(unit.category).toBe("program");
        // The title heading + 3 `##` sections.
        expect(unit.sections).toEqual([
            "Computer Science (BA)",
            "Overview",
            "Major Requirements",
            "Electives",
        ]);
        // Every section's content is present.
        expect(unit.text).toContain("CSCI-UA 101");
        expect(unit.text).toContain("advanced electives");
        // Document order is preserved.
        expect(unit.text.indexOf("## Overview")).toBeLessThan(
            unit.text.indexOf("## Major Requirements"),
        );
        expect(unit.text.indexOf("## Major Requirements")).toBeLessThan(
            unit.text.indexOf("## Electives"),
        );
        // It pulled ONLY the CS source, not Econ.
        expect(unit.text).not.toContain("ECON-UA");
    });

    it("returns null for a source path not in the store", async () => {
        const store = await storeWith(csChunks());
        expect(reassembleSource(store, "bulletin/cas/nope.md")).toBeNull();
    });
});

describe("reassembleSection (Phase B)", () => {
    it("returns just the requested section", async () => {
        const store = await storeWith(csChunks());
        const unit = reassembleSection(store, "bulletin/cas/cs-ba.md", "Major Requirements");
        expect(unit).not.toBeNull();
        if (!unit) return;
        expect(unit.sections).toEqual(["Major Requirements"]);
        expect(unit.text).toContain("CSCI-UA 101");
        // Other sections are NOT included.
        expect(unit.text).not.toContain("advanced electives");
        expect(unit.text).not.toContain("computational thinking");
    });
});

describe("reassembleSource — overlap removal at the splitter seam (Phase B)", () => {
    it("does not double-print the overlap when an oversized section is split", async () => {
        // 600 unique tokens in one section forces the chunker (500-token
        // max, 50-token overlap) to cut it into two overlapping pieces.
        const body = Array.from({ length: 600 }, (_, i) => `w${String(i + 1).padStart(3, "0")}`).join(" ");
        const md = `# Big Doc\n\n## Huge Section\n${body}\n`;
        const chunks = chunkMarkdown(
            md,
            {
                source: "Big Doc",
                school: "cas",
                year: "2025-2026",
                sourcePath: "bulletin/cas/big.md",
                category: "program",
            },
            { maxTokens: 500, overlapTokens: 50 },
        );
        // Sanity: the section really did get split (title chunk + 2 pieces).
        expect(chunks.length).toBeGreaterThanOrEqual(3);

        const store = await storeWith(chunks);
        const unit = reassembleSource(store, "bulletin/cas/big.md");
        expect(unit).not.toBeNull();
        if (!unit) return;

        const wTokens = unit.text.match(/w\d{3}/g) ?? [];
        // Every token appears exactly once (overlap stripped), in order.
        expect(wTokens.length).toBe(600);
        expect(new Set(wTokens).size).toBe(600);
        expect(wTokens[0]).toBe("w001");
        expect(wTokens[599]).toBe("w600");
    });
});

describe("locateBestSource (Phase B)", () => {
    const embedder = new LocalHashEmbedder(256);
    const reranker = new LocalLexicalReranker();

    it("locates the right program page for a curriculum query", async () => {
        const store = await storeWith(csChunks(), econChunks());
        const located = await locateBestSource(
            "computer science major requirements CSCI",
            { homeSchool: "cas", preferCategories: ["program"] },
            { store, embedder, reranker },
        );
        expect(located).not.toBeNull();
        expect(located?.sourcePath).toBe("bulletin/cas/cs-ba.md");
        expect(located?.topScore).toBeGreaterThan(0);
    });

    it("default-hard scope: a CAS student can't reach a Stern-only corpus", async () => {
        const store = await storeWith(sternChunks());
        const located = await locateBestSource(
            "business major requirements",
            { homeSchool: "cas" }, // no explicit "Stern" in the query
            { store, embedder, reranker },
        );
        expect(located).toBeNull();
    });

    it("a Stern student CAN reach the Stern page", async () => {
        const store = await storeWith(sternChunks());
        const located = await locateBestSource(
            "business major requirements",
            { homeSchool: "stern" },
            { store, embedder, reranker },
        );
        expect(located?.sourcePath).toBe("bulletin/stern/business-bs.md");
    });

    it("returns null on an empty corpus", async () => {
        const store = await storeWith();
        const located = await locateBestSource(
            "anything",
            { homeSchool: "cas" },
            { store, embedder, reranker },
        );
        expect(located).toBeNull();
    });
});
