// ============================================================
// Phase C — corpus ingest of the NYU-wide policy trees
// ============================================================
// Pins that buildCorpus({ includePolicyTrees: true }) picks up the
// previously-skipped internal-transfer-equivalencies + OGS (visa /
// immigration) trees from data/bulletin-raw, tags every file school
// "all" with the right category, and that the flag is opt-in (off ->
// no tree chunks). The actual cache regen (embedding) is a separate
// ops step — buildCorpus only chunks, so this runs without any API.

import { describe, expect, it } from "vitest";
import { buildCorpus } from "../../src/rag/corpus.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";

const embedder = new LocalHashEmbedder(64);

describe("buildCorpus — policy trees (Phase C)", () => {
    it("ingests the internal-transfer + OGS trees when includePolicyTrees is on", async () => {
        // entries: [] isolates the test to ONLY the policy trees.
        const { chunks } = await buildCorpus(embedder, {
            entries: [],
            includePolicyTrees: true,
            warnOnSkip: false,
        });

        const transfer = chunks.filter((c) =>
            c.meta.sourcePath.startsWith("internal-transfer-equivalencies/"),
        );
        const ogs = chunks.filter((c) => c.meta.sourcePath.startsWith("ogs/"));

        // The real trees exist in the repo, so both must produce chunks.
        expect(transfer.length).toBeGreaterThan(0);
        expect(ogs.length).toBeGreaterThan(0);

        // NYU-wide scope so every student can reach them.
        expect(transfer.every((c) => c.meta.school === "all")).toBe(true);
        expect(ogs.every((c) => c.meta.school === "all")).toBe(true);

        // Category tags drive the reranker preference.
        expect(transfer.every((c) => c.meta.category === "admissions")).toBe(true);
        expect(ogs.every((c) => c.meta.category === "academic_policy")).toBe(true);

        // Source labels are human-readable (not raw slugs).
        expect(transfer[0]!.meta.source.startsWith("NYU Internal Transfer:")).toBe(true);
        expect(ogs[0]!.meta.source.startsWith("NYU OGS (Global Services):")).toBe(true);
    });

    it("is opt-in: without the flag, no tree chunks are produced", async () => {
        const { chunks } = await buildCorpus(embedder, { entries: [], warnOnSkip: false });
        expect(chunks.length).toBe(0);
    });
});
