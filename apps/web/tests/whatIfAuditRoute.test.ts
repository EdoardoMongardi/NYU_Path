// ============================================================
// /api/whatif-audit (Plan 35 Branch A, G4.1) — exploration tests
// ============================================================
// Branch A: a student exploring a PROGRAM change uploads an Albert
// What-If report. It parses as `reportKind: "what_if"` and we plan it
// as a labeled, read-only EXPLORATION. The MUST-HAVE invariants under
// test:
//   - a what_if report → exploration plan + hypothetical-program label
//     + the "declare it in Albert" CTA;
//   - the authoritative profile store's parsed_dpr is NEVER written
//     (no profile/DPR/schedule persistence from this route);
//   - a NORMAL DPR routed here is rejected (the helper throws; the route
//     returns 400 + a redirect to /api/onboard);
//   - the route's no-file branch returns 400.
//
// Offline only (DATABASE_URL deleted → in-memory store bundle).
// ============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseDpr, InMemoryProfileStore } from "@nyupath/engine";
import {
    planWhatIfExploration,
    deriveHypotheticalProgram,
    POST,
} from "../app/api/whatif-audit/route";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { makeDpr } from "./_planRouteTestUtils";

const WHATIF_TEXT = readFileSync(
    join(__dirname, "..", "..", "..", "packages", "engine", "tests", "fixtures", "dpr_whatif_sample.redacted.txt"),
    "utf-8",
);

function parseWhatIf() {
    const r = parseDpr(WHATIF_TEXT, { pageCount: 8, nowIso: "2026-06-05T00:00:00Z" });
    if (!r.ok) throw new Error("fixture failed to parse: " + r.error);
    expect(r.report.reportKind).toBe("what_if");
    return r.report;
}

describe("/api/whatif-audit — Branch A exploration", () => {
    beforeEach(() => {
        delete process.env.DATABASE_URL; // force the in-memory bundle
        resetStoresForTests();
    });
    afterEach(() => {
        resetStoresForTests();
    });

    it("plans a what_if report as an exploration with the hypothetical-program label + CTA", async () => {
        const report = parseWhatIf();
        const result = await planWhatIfExploration(report);

        // Label flags it as hypothetical, names the program, and says it is
        // NOT the committed plan.
        expect(result.label.toLowerCase()).toContain("what-if");
        expect(result.label.toLowerCase()).toContain("not your committed plan");
        // The hypothetical program is derived from the report's Programs
        // table — Economics is the what-if major.
        expect(result.label).toContain("Economics");
        expect(result.exploration.hypotheticalProgram).toContain("Economics");

        // The CTA points the student at the real onboarding flow.
        expect(result.cta.toLowerCase()).toContain("declare it in albert");
        expect(result.cta.toLowerCase()).toContain("upload your new");

        // We get a real schedule + summary back.
        expect(result.exploration.schedule).toBeTruthy();
        expect(typeof result.exploration.summary).toBe("string");
        expect(result.exploration.summary.length).toBeGreaterThan(0);
    });

    it("NEVER writes the authoritative parsed_dpr (no profile/DPR persistence)", async () => {
        const report = parseWhatIf();

        // Drive the exploration through the helper the route uses.
        await planWhatIfExploration(report);

        // The in-memory profile store must hold NO persisted DPR for any
        // student — this route never writes parsed_dpr.
        const stores = getStores({});
        const profileStore = stores.profileStore as InMemoryProfileStore;
        // The synthetic student id derived from the report (if any) must
        // have no persisted DPR; and broadly, no student row exists.
        const derivedId = report.header.studentName.toLowerCase().replace(/\s+/g, "-");
        expect(await profileStore.getParsedDpr(derivedId)).toBeNull();
        expect(await profileStore.getParsedDpr("test-student")).toBeNull();
        expect(await profileStore.get(derivedId)).toBeNull();
    });

    it("rejects a NORMAL DPR (helper throws; never plans a real DPR as an exploration)", async () => {
        const realDpr = makeDpr(); // reportKind: "dpr"
        await expect(planWhatIfExploration(realDpr)).rejects.toThrow(/what_if/i);
    });

    it("derives a clean hypothetical-program label from the report", () => {
        const report = parseWhatIf();
        const label = deriveHypotheticalProgram(report);
        expect(label).toContain("Economics");
        // No leaked `Page N of M` page-runner prefix, no administrative
        // "UA-..." career rows.
        expect(label).not.toMatch(/Page\s+\d+\s+of\s+\d+/i);
        expect(label).not.toMatch(/^UA-/);
    });

    it("route returns 400 when no `dpr` file is present", async () => {
        const fd = new FormData();
        const req = new Request("http://localhost/api/whatif-audit", { method: "POST", body: fd });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await POST(req as any);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { message: string };
        expect(body.message.toLowerCase()).toContain("what-if");
    });
});
