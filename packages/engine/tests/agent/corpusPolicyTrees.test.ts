// ============================================================
// buildCorpus — full bulletin walk ("ingest all")
// ============================================================
// Pins that buildCorpus() (no entries override) walks the ENTIRE
// undergraduate bulletin tree + the NYU-wide internal-transfer / OGS /
// nyu trees, auto-tagging each page by school + category. buildCorpus
// only chunks (the embedder is local + deterministic), so this runs
// without any API.

import { describe, expect, it } from "vitest";
import { buildCorpus } from "../../src/rag/corpus.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";

const embedder = new LocalHashEmbedder(16);

describe("buildCorpus — full walk ingests everything", () => {
    it("ingests every undergrad school + the NYU-wide trees, tagged by school + category", async () => {
        const { chunks } = await buildCorpus(embedder, { warnOnSkip: false });

        const bySource = (prefix: string) => chunks.filter((c) => c.meta.sourcePath.startsWith(prefix));

        // NYU-wide trees → school "all".
        const transfer = bySource("internal-transfer-equivalencies/");
        const ogs = bySource("ogs/");
        expect(transfer.length).toBeGreaterThan(0);
        expect(ogs.length).toBeGreaterThan(0);
        expect(transfer.every((c) => c.meta.school === "all")).toBe(true);
        expect(ogs.every((c) => c.meta.school === "all")).toBe(true);
        expect(transfer.every((c) => c.meta.category === "admissions")).toBe(true);
        expect(ogs.every((c) => c.meta.category === "academic_policy")).toBe(true);

        // A NON-CAS school's admissions page is now ingested (previously
        // only CAS + Stern admissions were) — proves "ingest all".
        const tandonPages = chunks.filter((c) => c.meta.school === "tandon");
        const tandonAdmissions = tandonPages.filter((c) => c.meta.category === "admissions");
        expect(tandonPages.length).toBeGreaterThan(0);
        expect(tandonAdmissions.length).toBeGreaterThan(0);

        // Program pages across multiple schools are tagged "program".
        const programs = chunks.filter((c) => c.meta.category === "program");
        const programSchools = new Set(programs.map((c) => c.meta.school));
        expect(programs.length).toBeGreaterThan(0);
        expect(programSchools.size).toBeGreaterThan(1);
    });

    it("an explicit `entries` override still ingests just that set (test hook)", async () => {
        const { chunks } = await buildCorpus(embedder, { entries: [], warnOnSkip: false });
        expect(chunks.length).toBe(0);
    });
});
